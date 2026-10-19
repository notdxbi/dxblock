// dx.block filter compiler.
// Understands Adblock Plus, uBlock Origin and AdGuard filter syntax and turns it into:
//   - declarativeNetRequest rules (network blocking / allowing / redirects / param removal)
//   - cosmetic data (element hiding, procedural selectors, exceptions)
//   - scriptlet calls (name + args, AdGuard scriptlet names)
// Shared by the build (Node) and the extension service worker (custom filters),
// so it must not use Node or browser APIs.

export const PRIORITY = {
    block: 10,
    removeparam: 5,        // below block: Chrome applies only one redirect-type rule per request, and a
                           // query transform that changes nothing must never stop a block
    redirect: 15,          // beats a plain block, loses to an exception
    csp: 15,
    allow: 20,
    importantBlock: 30,
    importantAllow: 40,
    user: 50,              // user filters win over lists
    userAllow: 60,
    siteDisabled: 1_000_000
};

const RESOURCE_TYPES = {
    script: ['script'],
    image: ['image'],
    img: ['image'],
    stylesheet: ['stylesheet'],
    css: ['stylesheet'],
    object: ['object'],
    'object-subrequest': ['object'],
    xmlhttprequest: ['xmlhttprequest'],
    xhr: ['xmlhttprequest'],
    subdocument: ['sub_frame'],
    frame: ['sub_frame'],
    ping: ['ping'],
    beacon: ['ping'],
    media: ['media'],
    font: ['font'],
    websocket: ['websocket'],
    other: ['other', 'csp_report', 'webtransport', 'webbundle'],
    document: ['main_frame', 'sub_frame'],
    doc: ['main_frame', 'sub_frame']
};
const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
    'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];
// Types a plain filter applies to when it names none (everything except the page itself)
const DEFAULT_TYPES = ALL_TYPES.filter((t) => t !== 'main_frame');

// Options that are safe to ignore (cosmetic-only, stats, or engine hints)
const IGNORED_OPTIONS = new Set(['stealth', 'content', 'genericblock', 'extension', 'jsinject',
    'urlblock', 'network', 'stealth', 'inline-font', 'font-inline']);

// Redirect resource names (uBO + AdGuard aliases) -> file in /redirects/
export const REDIRECT_ALIASES = {};

export function registerRedirect(file, names) {
    for (const n of names) REDIRECT_ALIASES[n] = file;
}

// ---------------------------------------------------------------------------
// Preprocessor (!#if / !#else / !#endif / !#include)
// ---------------------------------------------------------------------------
const ENV = {
    env_chromium: true, env_mv3: true, ext_ublock: true, cap_user_stylesheet: true,
    adguard: false, adguard_ext_chromium: true, adguard_ext_chromium_mv3: true, env_edge: false,
    env_firefox: false, env_safari: false, env_mobile: false, env_legacy: false,
    cap_html_filtering: false, cap_ipaddress: false, ext_abp: false, ext_devbuild: false,
    false: false, true: true
};

function evalCondition(expr) {
    // Supports !, &&, || and parentheses over ENV tokens
    const tokens = expr.match(/!|&&|\|\||\(|\)|[\w-]+/g) || [];
    let i = 0;
    const parseOr = () => {
        let v = parseAnd();
        while (tokens[i] === '||') { i++; v = parseAnd() || v; }
        return v;
    };
    const parseAnd = () => {
        let v = parseNot();
        while (tokens[i] === '&&') { i++; v = parseNot() && v; }
        return v;
    };
    const parseNot = () => {
        if (tokens[i] === '!') { i++; return !parseNot(); }
        if (tokens[i] === '(') { i++; const v = parseOr(); i++; return v; }
        return ENV[tokens[i++]] === true;
    };
    return parseOr();
}

// Returns the active lines of a list. `include(name)` may return the text of an
// !#include'd file (or '' when unavailable).
export function preprocess(text, include = () => '') {
    const out = [];
    const stack = [];
    const active = () => stack.every((s) => s);
    for (let raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('!#if ')) { stack.push(evalCondition(line.slice(5))); continue; }
        if (line === '!#else') { if (stack.length) stack[stack.length - 1] = !stack[stack.length - 1]; continue; }
        if (line === '!#endif') { stack.pop(); continue; }
        if (!active()) continue;
        if (line.startsWith('!#include ')) {
            const sub = include(line.slice(10).trim());
            if (sub) out.push(...preprocess(sub, include));
            continue;
        }
        out.push(line);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------
// domains #sep# body   — sep is one of ## #@# #?# #@?# #$# #@$# #$?# #@$?# #%# #@%# ##^ #@#^ $$ $@$
const COSMETIC_RE = /^([^\s/|"'`]*?)(#@?(?:\$\??|\?|%)?#\^?|\$@?\$)(.+)$/;

export function classify(line) {
    if (!line || line.startsWith('!') || line.startsWith('[')) return null;
    if (line.startsWith('#') && !/^#[@?$%#]/.test(line)) return null;      // "# comment" (hosts files)
    const m = COSMETIC_RE.exec(line);
    if (m && !/^[|@]/.test(m[1])) {
        // Guard against URL filters containing "#" (e.g. ||site.com/#!/ad) — cosmetic domains never contain "/"
        return { kind: 'cosmetic', domains: m[1], sep: m[2], body: m[3] };
    }
    return { kind: 'network', text: line };
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ENTITY_RE = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+\.\*$/;

export function isHostname(h) {
    return h.length <= 253 && HOST_RE.test(h);
}
export function isEntity(h) {
    return ENTITY_RE.test(h);
}

// "a.com,~b.a.com" or "a.com|~b.com" -> { include: [...], exclude: [...], entityInclude, entityExclude }
export function parseDomainList(str, sep = ',') {
    const res = { include: [], exclude: [], entityInclude: [], entityExclude: [], invalid: false };
    if (!str) return res;
    for (let d of str.split(sep)) {
        d = d.trim().toLowerCase();
        if (!d) continue;
        const neg = d.startsWith('~');
        if (neg) d = d.slice(1);
        if (d.startsWith('/') && d.endsWith('/')) { res.invalid = true; continue; } // regex domains: unsupported
        if (isEntity(d)) (neg ? res.entityExclude : res.entityInclude).push(d);
        else if (isHostname(d)) (neg ? res.exclude : res.include).push(d);
        else res.invalid = true;
    }
    return res;
}

// ---------------------------------------------------------------------------
// Network filters -> DNR
// ---------------------------------------------------------------------------
function splitOptions(text) {
    // The options start at the last "$" that isn't part of a regex body
    let pattern = text;
    let opts = '';
    if (text.startsWith('/')) {
        const end = text.lastIndexOf('/');
        const dollar = text.indexOf('$', end);
        if (end > 0 && dollar !== -1) { pattern = text.slice(0, dollar); opts = text.slice(dollar + 1); }
    } else {
        const dollar = text.lastIndexOf('$');
        if (dollar !== -1 && !/[=,]$/.test(text.slice(0, dollar)) && /^[\w~-]/.test(text.slice(dollar + 1))) {
            pattern = text.slice(0, dollar);
            opts = text.slice(dollar + 1);
        }
    }
    return { pattern, opts };
}

function splitOptionList(opts) {
    // Commas inside values (e.g. removeparam=/a,b/) are escaped as "\,"
    const out = [];
    let cur = '';
    for (let i = 0; i < opts.length; i++) {
        const c = opts[i];
        if (c === '\\' && opts[i + 1] === ',') { cur += ','; i++; continue; }
        if (c === ',') { out.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur) out.push(cur);
    return out;
}

// Regex features RE2 (and therefore DNR) doesn't support
// and patterns likely to exceed Chrome's per-regex memory limit (one such rule fails the whole install)
function regexSupported(re) {
    if (/\(\?[=!<]|\\\d|\(\?</.test(re)) return false;
    if (re.length > 300) return false;
    for (const m of re.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
        if (Number(m[1]) > 50 || (m[2] && Number(m[2]) > 50)) return false;
    }
    // Nested quantifiers like (a+)+ or (?:[a-z]{2,8}\.)+ blow up the compiled program
    if (/\)[*+]|\)\{\d/.test(re) && /[*+}]\)/.test(re)) return false;
    return true;
}

const ASCII_RE = /^[\x20-\x7e]*$/;

// Converts one network filter. Returns { rules: [...], badfilter?, cosmeticException? } or null if unsupported.
export function convertNetworkFilter(text, { user = false } = {}) {
    let isException = false;
    let t = text;
    if (t.startsWith('@@')) { isException = true; t = t.slice(2); }
    const { pattern: rawPattern, opts } = splitOptions(t);
    let pattern = rawPattern;

    const cond = {};
    let types = null;           // explicit include types
    const excludedTypes = new Set();
    let important = false;
    let matchCase = false;
    let redirect = null;
    let removeparam = null;
    let csp = null;
    let badfilter = false;
    let documentOpt = false;
    let popupOpt = false;
    const cosmeticExc = [];

    for (let opt of splitOptionList(opts)) {
        let neg = false;
        if (opt.startsWith('~')) { neg = true; opt = opt.slice(1); }
        const eq = opt.indexOf('=');
        const name = (eq === -1 ? opt : opt.slice(0, eq)).toLowerCase();
        const value = eq === -1 ? '' : opt.slice(eq + 1);

        if (RESOURCE_TYPES[name]) {
            if (name === 'document' || name === 'doc') {
                if (neg) { excludedTypes.add('main_frame'); continue; }
                documentOpt = true;
                (types ||= new Set()).add('main_frame');
                if (isException) (types ||= new Set()).add('sub_frame');
                continue;
            }
            if (neg) RESOURCE_TYPES[name].forEach((x) => excludedTypes.add(x));
            else RESOURCE_TYPES[name].forEach((x) => (types ||= new Set()).add(x));
            continue;
        }
        switch (name) {
        case 'all':
            ALL_TYPES.forEach((x) => (types ||= new Set()).add(x));
            break;
        case 'third-party': case '3p': case 'strict3p': case 'strict-third-party':
            cond.domainType = neg ? 'firstParty' : 'thirdParty';
            break;
        case 'first-party': case '1p': case 'strict1p': case 'strict-first-party':
            cond.domainType = neg ? 'thirdParty' : 'firstParty';
            break;
        case 'domain': case 'from': {
            const d = parseDomainList(value, '|');
            if (d.invalid && !d.include.length && !d.exclude.length) return null;
            // Entity domains (google.*) can't be expressed in DNR: drop them
            if (d.entityInclude.length && !d.include.length) return null;
            if (d.include.length) cond.initiatorDomains = d.include;
            if (d.exclude.length) cond.excludedInitiatorDomains = d.exclude;
            break;
        }
        case 'to': case 'denyallow': {
            const d = parseDomainList(value, '|');
            if (name === 'denyallow') {
                if (d.include.length) cond.excludedRequestDomains = d.include;
            } else {
                if (d.entityInclude.length && !d.include.length) return null;
                if (d.include.length) cond.requestDomains = d.include;
                if (d.exclude.length) cond.excludedRequestDomains = d.exclude;
            }
            break;
        }
        case 'method': {
            const inc = [], exc = [];
            for (let m of value.toLowerCase().split('|')) {
                if (m.startsWith('~')) exc.push(m.slice(1)); else inc.push(m);
            }
            const ok = ['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other'];
            if (inc.length) cond.requestMethods = inc.filter((m) => ok.includes(m));
            if (exc.length) cond.excludedRequestMethods = exc.filter((m) => ok.includes(m));
            break;
        }
        case 'important':
            important = true;
            break;
        case 'match-case':
            matchCase = true;
            break;
        case 'badfilter':
            badfilter = true;
            break;
        case 'redirect': case 'rewrite':
            redirect = value.replace(/^abp-resource:/, '').replace(/:\d+$/, '');
            break;
        case 'redirect-rule':
            // Only meant to apply when something else blocks the request; not expressible in DNR
            return null;
        case 'empty':
            redirect = 'nooptext';
            break;
        case 'mp4':
            redirect = 'noopmp4-1s';
            (types ||= new Set()).add('media');
            break;
        case 'removeparam': case 'queryprune':
            if (value.startsWith('~')) return null;                          // negated: unsupported
            if (value.startsWith('/')) {
                // DNR only removes exact names: expand simple regexes ("/^utm_/", "/^(a|b)=/")
                const names = expandParamRegex(value);
                if (!names) return null;
                removeparam = names.join('|');
                break;
            }
            removeparam = value;
            break;
        case 'csp':
            csp = value;
            break;
        case 'elemhide': case 'ehide':
            cosmeticExc.push('elemhide');
            break;
        case 'generichide': case 'ghide':
            cosmeticExc.push('generichide');
            break;
        case 'specifichide': case 'shide':
            cosmeticExc.push('specifichide');
            break;
        case 'popup':
            // DNR can't block pop-ups: the service worker closes them instead (see popupFilter)
            if (!neg) popupOpt = true;
            break;
        case 'popunder':
            return null;
        case 'inline-script':
            csp = "script-src 'self' * 'unsafe-eval'";
            break;
        default:
            if (IGNORED_OPTIONS.has(name)) break;
            return null;  // unknown/unsupported option ($replace, $header, $permissions, $cname, ...)
        }
    }

    // Exception filters that only switch off cosmetic filtering
    if (cosmeticExc.length) {
        const host = /^\|\|([a-z0-9.-]+)\^?$/.exec(pattern.toLowerCase());
        const result = { rules: [], cosmeticException: null };
        if (isException && host && isHostname(host[1])) {
            result.cosmeticException = { host: host[1], kinds: cosmeticExc };
        }
        if (types === null && !documentOpt) return result;  // nothing network-related left
    }

    if (popupOpt) {
        if (types && types.size) popupOpt = false;      // "$script,popup": keep the network part only
        else return { rules: [], popup: popupFilter(pattern, isException, cond) };
    }

    if (badfilter) return { rules: [], badfilter: text.replace(/(\$|,)badfilter\b/, '').replace(/,$/, '').replace(/\$$/, '') };

    // Pattern
    let urlFilter;
    let regexFilter;
    if (pattern.length > 1 && pattern.startsWith('/') && pattern.endsWith('/')) {
        const re = pattern.slice(1, -1);
        if (!regexSupported(re)) return null;
        regexFilter = re;
    } else {
        // Hosts-file style lines ("0.0.0.0 example.com") and bare hostnames
        const hostsLine = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9.-]+)$/i.exec(pattern);
        if (hostsLine) pattern = `||${hostsLine[1]}^`;
        if (pattern === '*' || pattern === '') pattern = '';
        if (pattern.startsWith('*') && !pattern.startsWith('**')) pattern = pattern.replace(/^\*+/, '');
        if (pattern.endsWith('*')) pattern = pattern.replace(/\*+$/, '');
        if (pattern.startsWith('||*')) pattern = pattern.slice(3);
        if (pattern && !ASCII_RE.test(pattern)) return null;
        // "||" only at the start, "|" only at either end
        if (pattern && (pattern.indexOf('||', 1) !== -1 || /.\|./.test(pattern.replace(/^\|\|/, '')))) return null;
        if (pattern) urlFilter = matchCase ? pattern : pattern.toLowerCase();
    }

    // A rule with no pattern needs something else to narrow it down
    if (!urlFilter && !regexFilter && !cond.initiatorDomains && !cond.requestDomains && !documentOpt) {
        if (!removeparam && !csp) return null;
    }

    // Resource types
    let resourceTypes = types ? [...types].filter((x) => !excludedTypes.has(x)) : null;
    if (types && types.size === 0) return null;            // only $popup etc.
    if (resourceTypes && !resourceTypes.length) return null;
    if (!resourceTypes && excludedTypes.size) {
        resourceTypes = DEFAULT_TYPES.filter((x) => !excludedTypes.has(x));
    }

    if (cond.requestMethods && !cond.requestMethods.length) return null;
    if (cond.excludedRequestMethods && !cond.excludedRequestMethods.length) delete cond.excludedRequestMethods;
    const condition = { ...cond };
    if (urlFilter) condition.urlFilter = urlFilter;
    if (regexFilter) condition.regexFilter = regexFilter;
    if (matchCase) condition.isUrlFilterCaseSensitive = true;
    if (resourceTypes) condition.resourceTypes = resourceTypes;

    // Pure-domain block rule ("||example.com^") -> requestDomains, which lets the build merge them
    const pure = urlFilter && /^\|\|([a-z0-9.-]+)\^$/.exec(urlFilter);
    if (pure && isHostname(pure[1]) && !condition.requestDomains) {
        delete condition.urlFilter;
        condition.requestDomains = [pure[1]];
    }

    let action;
    let priority;
    if (isException) {
        if (documentOpt && (!types || types.has('main_frame'))) {
            action = { type: 'allowAllRequests' };
            condition.resourceTypes = ['main_frame', 'sub_frame'];
        } else if (removeparam !== null || csp !== null || redirect !== null) {
            // Exceptions for these modifiers just turn the modifier off: plain allow is too broad, skip
            return null;
        } else {
            action = { type: 'allow' };
        }
        priority = important ? PRIORITY.importantAllow : PRIORITY.allow;
        if (user) priority = PRIORITY.userAllow;
    } else if (redirect !== null) {
        const file = REDIRECT_ALIASES[redirect];
        if (!file) return null;
        action = { type: 'redirect', redirect: { extensionPath: `/redirects/${file}` } };
        priority = important ? PRIORITY.importantBlock + 1 : PRIORITY.redirect;
        if (!condition.resourceTypes) return null;   // redirects always name a type in practice
    } else if (removeparam !== null) {
        const transform = removeparam === ''
            ? { query: '' }
            : { queryTransform: { removeParams: removeparam.split('|').filter(Boolean) } };
        action = { type: 'redirect', redirect: { transform } };
        condition.resourceTypes ||= ['main_frame', 'sub_frame', 'xmlhttprequest'];
        priority = PRIORITY.removeparam;
    } else if (csp !== null) {
        if (!csp) return null;
        action = {
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: csp }]
        };
        condition.resourceTypes = (condition.resourceTypes || ['main_frame', 'sub_frame'])
            .filter((x) => x === 'main_frame' || x === 'sub_frame');
        if (!condition.resourceTypes.length) return null;
        priority = PRIORITY.csp;
    } else {
        action = { type: 'block' };
        priority = important ? PRIORITY.importantBlock : PRIORITY.block;
        if (user) priority = PRIORITY.user;
    }

    return { rules: [{ priority, action, condition }] };
}

// Pop-up filter -> data the service worker matches against new tabs
function popupFilter(pattern, isException, cond) {
    let re;
    if (pattern.length > 1 && pattern.startsWith('/') && pattern.endsWith('/')) re = pattern.slice(1, -1);
    else re = patternToRegex(pattern);
    const p = { re };
    if (isException) p.allow = 1;
    if (cond.initiatorDomains) p.d = cond.initiatorDomains;
    if (cond.excludedInitiatorDomains) p.xd = cond.excludedInitiatorDomains;
    if (cond.domainType) p.t = cond.domainType === 'thirdParty' ? 3 : 1;
    return p;
}

// ABP pattern -> RegExp source
export function patternToRegex(pattern) {
    let p = pattern;
    let prefix = '';
    let suffix = '';
    if (p.startsWith('||')) { prefix = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\/?#]+\\.)?'; p = p.slice(2); }
    else if (p.startsWith('|')) { prefix = '^'; p = p.slice(1); }
    if (p.endsWith('|')) { suffix = '$'; p = p.slice(0, -1); }
    const body = p.replace(/[.+?${}()[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\^/g, '(?:[^\\w.%-]|$)');
    return prefix + body + suffix;
}

// Well-known tracking parameters, used to expand prefix regexes like /^utm_/
const KNOWN_PARAMS = {
    utm_: ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name', 'utm_cid',
        'utm_reader', 'utm_referrer', 'utm_social', 'utm_social-type', 'utm_brand', 'utm_place', 'utm_pubreferrer',
        'utm_swu', 'utm_viz_id', 'utm_int', 'utm_creative_format', 'utm_marketing_tactic', 'utm_source_platform',
        'utm_campaign_id', 'utm_adgroup', 'utm_keyword', 'utm_device', 'utm_placement', 'utm_network', 'utm_channel'],
    ref_: ['ref_src', 'ref_url', 'ref_source', 'ref_type', 'ref_campaign'],
    trk: ['trk', 'trkCampaign', 'trkInfo', 'trk_source', 'trk_medium', 'trk_campaign'],
    itm_: ['itm_source', 'itm_medium', 'itm_campaign', 'itm_content', 'itm_term'],
    subid: ['subid', 'subid1', 'subid2', 'subid3', 'subid4', 'subid5'],
    mkt_tok: ['mkt_tok'],
    cm_mmc: ['cm_mmc'],
    at_custom: ['at_custom1', 'at_custom2', 'at_custom3', 'at_custom4']
};

function expandParamRegex(value) {
    const m = /^\/(.*)\/$/.exec(value);
    if (!m) return null;
    let re = m[1];
    // "^(a|b|c)=" or "^(?:a|b)$" -> exact names
    let alt = /^\^\(\?:?([\w|-]+)\)(?:=|\$)?$/.exec(re) || /^\^\(([\w|-]+)\)(?:=|\$)?$/.exec(re);
    if (alt) return alt[1].split('|').filter(Boolean);
    // "^name=" or "^name$"
    const exact = /^\^([\w-]+)(?:=|\$)$/.exec(re);
    if (exact) return [exact[1]];
    // "^prefix" -> known names with that prefix
    const prefix = /^\^?([\w-]+)$/.exec(re);
    if (prefix && KNOWN_PARAMS[prefix[1]]) return KNOWN_PARAMS[prefix[1]];
    return null;
}

// Merge block/allow rules that only differ by requestDomains into one rule (huge rule-count saving)
export function mergeRules(rules) {
    const merged = new Map();
    const out = [];
    for (const r of rules) {
        const c = r.condition;
        if (c.requestDomains && !c.urlFilter && !c.regexFilter && (r.action.type === 'block' || r.action.type === 'allow')) {
            const { requestDomains, ...rest } = c;
            const key = JSON.stringify([r.priority, r.action, rest]);
            let m = merged.get(key);
            if (!m) {
                m = { priority: r.priority, action: r.action, condition: { ...rest, requestDomains: [] } };
                merged.set(key, m);
                out.push(m);
            }
            m.condition.requestDomains.push(...requestDomains);
            continue;
        }
        out.push(r);
    }
    for (const m of merged.values()) {
        m.condition.requestDomains = [...new Set(m.condition.requestDomains)];
    }
    return mergeRemoveParams(out);
}

// Chrome applies a single query-transform rule per request, so separate "$removeparam=x" rules would
// each strip only their own parameter (and usually the wrong rule wins). Merge rules with the same
// condition, and fold the site-wide parameter list into every site-specific rule.
function mergeRemoveParams(rules) {
    const isRp = (r) => r.action.type === 'redirect' && r.action.redirect.transform?.queryTransform?.removeParams;
    const groups = new Map();
    const out = [];
    for (const r of rules) {
        if (!isRp(r)) { out.push(r); continue; }
        const key = JSON.stringify([r.priority, r.condition]);
        const g = groups.get(key);
        if (g) { g.action.redirect.transform.queryTransform.removeParams.push(...r.action.redirect.transform.queryTransform.removeParams); continue; }
        const copy = { priority: r.priority, action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: [...r.action.redirect.transform.queryTransform.removeParams] } } } }, condition: r.condition };
        groups.set(key, copy);
        out.push(copy);
    }
    const generic = [...groups.values()].filter((r) => Object.keys(r.condition).every((k) => k === 'resourceTypes'));
    const globalParams = [...new Set(generic.flatMap((r) => r.action.redirect.transform.queryTransform.removeParams))];
    for (const r of groups.values()) {
        const params = r.action.redirect.transform.queryTransform.removeParams;
        const all = generic.includes(r) ? params : [...params, ...globalParams];
        r.action.redirect.transform.queryTransform.removeParams = [...new Set(all)];
    }
    return out;
}

// ---------------------------------------------------------------------------
// Cosmetic filters
// ---------------------------------------------------------------------------
// Procedural (extended) pseudo-classes that need ExtendedCss instead of plain CSS
const EXTENDED_RE = /:(?:-abp-has|-abp-contains|-abp-properties|has-text|contains|matches-css(?:-before|-after)?|matches-attr|matches-property|xpath|nth-ancestor|upward|remove|watch-attr|min-text-length|if|if-not|others|matches-path|style)\(|:remove\(\)/;
const UNSUPPORTED_RE = /:(?:matches-path|others|watch-attr|matches-media)\(/;

// Returns a cosmetic entry or null.
//   { type: 'hide', selector, domains, exception }
//   { type: 'extended', rule, domains, exception }      (ExtendedCss rule text)
//   { type: 'css', css, domains, exception }             (AdGuard #$# style injection)
//   { type: 'scriptlet', calls: [{ name, args }], domains, exception }
export function convertCosmeticFilter(c, scriptletConverter) {
    const domains = parseDomainList(c.domains, ',');
    if (domains.invalid && !domains.include.length && !domains.exclude.length && !domains.entityInclude.length) return null;
    const sep = c.sep;
    const exception = sep.includes('@');
    let body = c.body.trim();
    if (!body) return null;

    if (sep.endsWith('^') || sep.startsWith('$')) return null;           // HTML filtering: not possible in MV3

    // Scriptlets: uBO ##+js(...), AdGuard #%#//scriptlet(...), ABP #$#snippet
    if ((sep === '##' || sep === '#@#') && body.startsWith('+js(')) {
        const calls = scriptletConverter?.(`${c.domains}${sep}${body}`);
        return calls?.length ? { type: 'scriptlet', calls, domains, exception } : null;
    }
    if (sep === '#%#' || sep === '#@%#') {
        if (!body.startsWith('//scriptlet(')) return null;              // raw JS injection: never run list-provided code
        const calls = scriptletConverter?.(`${c.domains}${sep}${body}`);
        return calls?.length ? { type: 'scriptlet', calls, domains, exception } : null;
    }
    if (sep === '#$#' || sep === '#@$#' || sep === '#$?#' || sep === '#@$?#') {
        // AdGuard CSS injection: "selector { prop: value }" ; ABP snippets also use #$#
        const m = /^(.+?)\s*\{([^{}]*)\}\s*$/.exec(body);
        if (!m) {
            const calls = scriptletConverter?.(`${c.domains}${sep}${body}`);
            return calls?.length ? { type: 'scriptlet', calls, domains, exception } : null;
        }
        if (/url\(|expression|@import|javascript:/i.test(m[2])) return null;
        if (sep.includes('?') || EXTENDED_RE.test(m[1])) {
            return { type: 'extended', rule: `${m[1]} { ${m[2]} }`, domains, exception };
        }
        return { type: 'css', css: `${m[1]} { ${m[2]} }`, domains, exception };
    }

    // "## selector { style }" (used by EasyList for layout fixes) -> CSS injection
    const block = /^(.+?)\s*\{([^{}]*)\}\s*$/.exec(body);
    if (block && !sep.includes('?')) {
        if (/url\(|expression|@import|javascript:/i.test(block[2])) return null;
        if (/^\s*remove\s*:\s*true\s*;?\s*$/.test(block[2]) || EXTENDED_RE.test(block[1])) {
            return { type: 'extended', rule: body, domains, exception };
        }
        return { type: 'css', css: `${block[1]} { ${block[2]} }`, domains, exception };
    }

    // uBO ":style()" -> CSS injection
    const style = /^(.+?):style\((.+)\)$/.exec(body);
    if (style && !EXTENDED_RE.test(style[1])) {
        if (/url\(|expression|@import|javascript:/i.test(style[2])) return null;
        return { type: 'css', css: `${style[1]} { ${style[2]} !important }`, domains, exception };
    }

    if (UNSUPPORTED_RE.test(body)) return null;
    if (sep === '#?#' || sep === '#@?#' || EXTENDED_RE.test(body)) {
        return { type: 'extended', rule: body, domains, exception };
    }
    if (/[{}]/.test(body) || body.length > 1000) return null;
    return { type: 'hide', selector: body, domains, exception };
}

// The class/id a generic selector can be keyed by (uBO-style lazy generic hiding).
// ".ad-banner > img" -> ".ad-banner"; "div[id^='ad']" -> null (always applied)
export function genericKey(selector) {
    const m = /^(?:[a-z]*)([.#])([\w-]+)/i.exec(selector);
    if (m) return m[1] + m[2];
    return null;
}

// ---------------------------------------------------------------------------
// Per-site data buckets (shared by the build and the service worker)
// ---------------------------------------------------------------------------
export const BUCKETS = 64;
const SLD = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil', 'nic', 'gen', 'biz', 'info']);
// Registrable-ish base domain, so a site and its subdomains land in the same bucket
export function baseDomain(h) {
    const p = h.split('.');
    if (p.length > 2 && p[p.length - 1].length === 2 && SLD.has(p[p.length - 2])) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
}
export function bucketOf(host) {
    const b = baseDomain(host);
    let x = 0;
    for (let i = 0; i < b.length; i++) x = (Math.imul(x, 31) + b.charCodeAt(i)) >>> 0;
    return x % BUCKETS;
}
