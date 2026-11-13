// dx.block service worker
import {
    classify, convertNetworkFilter, convertCosmeticFilter, preprocess, registerRedirect, PRIORITY, bucketOf
} from './lib/filters.js';
import { S as SCRIPTLETS, ALIASES, VERSION as SCRIPTLETS_VERSION } from './lib/scriptlet-lib.js';
import * as stats from './stats.js';
import { lookalike, toUnicode } from './lib/lookalike.js';
import { REPLAY_DOMAINS } from './lib/replay.js';

const DNR = chrome.declarativeNetRequest;
const IS_FIREFOX = typeof browser !== 'undefined' && typeof browser.runtime?.getBrowserInfo === 'function';

// Keep the last few errors for the Diagnostics page
const errors = [];
const logError = (where, err) => {
    errors.unshift({ where, message: String(err?.message || err), t: Date.now() });
    errors.length = Math.min(errors.length, 20);
};
self.addEventListener('error', (e) => logError('worker', e.message));
self.addEventListener('unhandledrejection', (e) => logError('promise', e.reason));
const USER_RULE_BASE = 10_000;
const TWEAK_RULE_BASE = 9_000;
const DYNAMIC_LIST_BASE = 100_000;
const HOTFIX_RULE_BASE = 50_000;

// Tracking redirects dx.block skips. dnr: RE2 pattern for the main-frame redirect rule; params: where the real URL is.
const UNWRAP = [
    { dnr: '^https?://(?:www\\.)?google\\.[a-z.]{2,7}/url\\?(?:.*&)?(?:q|url)=https?', re: '^https?://(?:www\\.)?google\\.[a-z.]{2,7}/url\\?', params: ['q', 'url'] },
    { dnr: '^https?://(?:l|lm)\\.facebook\\.com/l\\.php\\?', re: '^https?://(?:l|lm)\\.facebook\\.com/l\\.php\\?', params: ['u'] },
    { dnr: '^https?://l\\.instagram\\.com/\\?', re: '^https?://l\\.instagram\\.com/\\?', params: ['u'] },
    { dnr: '^https?://l\\.messenger\\.com/l\\.php\\?', re: '^https?://l\\.messenger\\.com/l\\.php\\?', params: ['u'] },
    { dnr: '^https?://l\\.threads\\.(?:net|com)/\\?', re: '^https?://l\\.threads\\.(?:net|com)/\\?', params: ['u'] },
    { dnr: '^https?://out\\.reddit\\.com/', re: '^https?://out\\.reddit\\.com/', params: ['url'] },
    { dnr: '^https?://(?:www\\.)?youtube\\.com/redirect\\?', re: '^https?://(?:www\\.)?youtube\\.com/redirect\\?', params: ['q'] },
    { dnr: '^https?://(?:m\\.)?vk\\.com/away\\.php\\?', re: '^https?://(?:m\\.)?vk\\.com/away\\.php\\?', params: ['to'] },
    { dnr: '^https?://(?:www\\.)?linkedin\\.com/redir/redirect\\?', re: '^https?://(?:www\\.)?linkedin\\.com/redir/redirect\\?', params: ['url'] },
    { dnr: '^https?://disq\\.us/url\\?', re: '^https?://disq\\.us/url\\?', params: ['url'] },
    { dnr: '^https?://(?:www\\.)?duckduckgo\\.com/l/\\?', re: '^https?://(?:www\\.)?duckduckgo\\.com/l/\\?', params: ['uddg'] },
    { dnr: '^https?://href\\.li/\\?', re: '^https?://href\\.li/\\?', params: ['*'] },
    { dnr: '^https?://slack-redir\\.net/link\\?', re: '^https?://slack-redir\\.net/link\\?', params: ['url'] },
    { dnr: '^https?://(?:www\\.)?deviantart\\.com/users/outgoing\\?', re: '^https?://(?:www\\.)?deviantart\\.com/users/outgoing\\?', params: ['*'] },
    { dnr: '^https?://t\\.umblr\\.com/redirect\\?', re: '^https?://t\\.umblr\\.com/redirect\\?', params: ['z'] },
    { dnr: '^https?://(?:www\\.)?pinterest\\.[a-z.]+/offsite/\\?', re: '^https?://(?:www\\.)?pinterest\\.[a-z.]+/offsite/\\?', params: ['url'] }
];
const SITE_RULE_BASE = 1;
const LOCK_RULE_BASE = 8_000;    // Lockdown mode: 3 rules per locked site (up to 300 sites)
const GLOBAL_OFF_RULE = 8_999;   // the main switch: one allow-everything rule while dx.block is off

// ---------------------------------------------------------------------------
// Data (loaded lazily, kept while the worker lives)
// ---------------------------------------------------------------------------
const cache = {};
async function json(path) {
    if (!cache[path]) cache[path] = fetch(chrome.runtime.getURL(path)).then((r) => r.json());
    return cache[path];
}
const lists = () => json('data/lists.json');
const registry = () => json('data/registry.json');
const generic = (g) => json(`data/${g}-generic.json`);
const entity = (g) => json(`data/${g}-entity.json`);
const flags = () => json('data/flags.json');
const sites = (g, host) => json(`data/${g}-sites-${bucketOf(host)}.json`);
let popupDomainSet = null;
const popupDomains = async () => (popupDomainSet ||= new Set(await json('data/popup-domains.json')));

let redirectsReady = null;
function ensureRedirects() {
    redirectsReady ||= json('data/redirects.json').then((map) => {
        const byFile = {};
        for (const [alias, file] of Object.entries(map)) (byFile[file] ||= []).push(alias);
        for (const [file, names] of Object.entries(byFile)) registerRedirect(file, names);
    });
    return redirectsReady;
}

let popupFilters = null;
async function getPopupFilters() {
    if (!popupFilters) {
        const raw = await json('data/popups.json');
        const { user } = await userData();
        const hf = (await settings()).tweaks.hotfix ? (await hotfixData()).popups : [];
        popupFilters = [...raw, ...user.popups, ...hf].map((p) => {
            try { return { ...p, rx: new RegExp(p.re, 'i') }; } catch { return null; }
        }).filter(Boolean);
    }
    return popupFilters;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const REPO = 'notdxbi/dxblock';
const TWEAK_DEFAULTS = {
    updateCheck: true,       // daily check of GitHub releases for a newer version
    webrtc: true,            // stop WebRTC from revealing your real IP
    gpc: true,               // send Global Privacy Control / Do Not Track
    referrer: false,         // strip the Referer header on third-party requests
    notifications: false,    // auto-deny "Allow notifications?" prompts
    fingerprint: true,       // noise for canvas / WebGL / audio / font fingerprinting
    unwrap: true,            // skip tracking redirects (google.com/url, l.facebook.com, ...)
    amp: true,               // AMP pages -> the original article
    beacons: true,           // block third-party tracking beacons and link-click pings
    cookies3p: true,         // no cookies sent to / set by third-party resources (embedded frames keep theirs)
    lookalike: true,         // warn on fake sites imitating well-known brands
    httpWarn: true,          // warn before typing a password on an insecure (http) page
    httpsOnly: false,        // upgrade every connection to HTTPS (falls back when a site has no HTTPS)
    blend: false,            // sites see UTC and US English
    forget: false,           // delete a site's cookies and storage when its last tab closes
    keepSites: [],           // ... except these
    sponsorblock: false,     // skip sponsor segments on YouTube
    hotfix: true,            // daily fast fixes from the dx.block repo
    replay: true,            // block session-recording scripts (Hotjar, FullStory, Clarity, ...) and say so
    consent: true,           // press "Reject all" on cookie banners
    darkPatterns: true,      // outline fake countdowns, "only 2 left", guilt-trip buttons, pre-ticked boxes
    clipboard: true,         // stop sites changing what you copy
    searchGrades: true,      // privacy grade + breach chip next to search results
    siteBreaches: true,      // show a site's known data breaches (Have I Been Pwned list, kept locally)
    hideAI: false,           // hide AI answers and sponsored results on search engines
    hideShorts: false,       // hide YouTube Shorts
    hideEndscreens: false,   // hide YouTube end-screen suggestions
    hideAmazonAds: false,    // hide Amazon sponsored products
    proxy: { mode: 'off', scheme: 'socks5', host: '127.0.0.1', port: 9050, user: '', pass: '' }
};
const DEFAULTS = { enabled: true, lists: {}, disabledSites: [], lockedSites: [], userFilters: '', tweaks: TWEAK_DEFAULTS };
async function settings() {
    const s = await chrome.storage.local.get(DEFAULTS);
    return { ...DEFAULTS, ...s, tweaks: { ...TWEAK_DEFAULTS, ...s.tweaks, proxy: { ...TWEAK_DEFAULTS.proxy, ...(s.tweaks?.proxy || {}) } } };
}

async function enabledLists() {
    const [all, s] = await Promise.all([lists(), settings()]);
    return all.filter((l) => (l.id in s.lists ? s.lists[l.id] : l.on));
}
async function enabledGroups() {
    return new Set((await enabledLists()).map((l) => l.group));
}

// ---------------------------------------------------------------------------
// Hostname helpers
// ---------------------------------------------------------------------------
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
function hostChain(host) {
    const out = [];
    let d = host;
    while (d) {
        out.push(d);
        const i = d.indexOf('.');
        if (i < 0) break;
        d = d.slice(i + 1);
    }
    return out;
}
// "www.google.co.uk" -> ["www.google.*", "google.*"] (entity keys)
function entityChain(host) {
    const parts = host.split('.');
    const out = [];
    for (let i = 0; i < parts.length - 1; i++) {
        for (let j = parts.length - 1; j > i; j--) out.push(`${parts.slice(i, j).join('.')}.*`);
    }
    return out;
}
const baseOf = (h) => h.split('.').slice(-2).join('.');
const sitePatterns = (h) => (/^[\d.]+$|:/.test(h) ? [`*://${h}/*`] : [`*://*.${h}/*`]);   // *.h also matches h

async function isDisabled(host) {
    const { disabledSites, enabled } = await settings();
    if (enabled === false) return true;   // main switch off: everything is allowed everywhere
    if (!host) return false;
    const chain = hostChain(host);
    return disabledSites.some((s) => chain.includes(s));
}

// ---------------------------------------------------------------------------
// User filters ("My filters")
// ---------------------------------------------------------------------------
let userCache = null;

// Minimal scriptlet parser for user filters: uBO "+js(name, a, b)" and AdGuard "//scriptlet('name', 'a')"
function userScriptlet(ruleText) {
    let name;
    let args;
    let m = /#@?#\+js\((.*)\)$/.exec(ruleText);
    if (m) {
        if (!m[1].trim()) return [{ name: '*', args: [] }];
        const parts = m[1].split(/(?<!\\),/).map((x) => x.trim().replace(/\\,/g, ','));
        name = parts.shift();
        args = parts;
    } else if ((m = /#@?%#\/\/scriptlet\((.*)\)$/.exec(ruleText))) {
        const parts = [...m[1].matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map((x) => x[2].replace(/\\(.)/g, '$1'));
        name = parts.shift();
        args = parts;
    } else {
        return null;
    }
    const canonical = ALIASES[name] || ALIASES[`${name}.js`] || ALIASES[name.replace(/^ubo-/, '')] || ALIASES[`ubo-${name}`];
    return canonical && SCRIPTLETS[canonical] ? [{ name: canonical, args }] : null;
}

async function compileUserFilters(text) {
    await ensureRedirects();
    const rules = [];
    const popups = [];
    const cosmetic = { hide: {}, css: {}, ext: {}, js: {}, genericHide: [], exc: {} };
    const errors = [];
    let ok = 0;
    for (const line of preprocess(text)) {
        const c = classify(line);
        if (!c) continue;
        if (c.kind === 'network') {
            const r = convertNetworkFilter(c.text, { user: true });
            if (!r || (!r.rules.length && !r.popup)) { errors.push(line); continue; }
            if (r.popup) popups.push(r.popup);
            rules.push(...r.rules);
            ok++;
            continue;
        }
        const e = convertCosmeticFilter(c, userScriptlet);
        if (!e) { errors.push(line); continue; }
        ok++;
        const hosts = [...e.domains.include, ...e.domains.entityInclude];
        const push = (store, h, v) => (store[h] ||= []).push(v);
        if (e.exception) {
            for (const h of hosts) push(cosmetic.exc, h, e.selector || e.css || e.rule || '*');
            continue;
        }
        if (e.type === 'hide') {
            if (!hosts.length) cosmetic.genericHide.push(e.selector);
            for (const h of hosts) push(cosmetic.hide, h, e.selector);
        } else if (e.type === 'css') {
            for (const h of hosts) push(cosmetic.css, h, e.css);
        } else if (e.type === 'extended') {
            for (const h of hosts) push(cosmetic.ext, h, e.rule);
        } else if (e.type === 'scriptlet') {
            for (const h of hosts) for (const call of e.calls) push(cosmetic.js, h, [call.name, call.args]);
        }
    }
    return { rules, popups, cosmetic, errors, ok };
}

async function userData() {
    if (!userCache) {
        const { userFilters } = await settings();
        userCache = await compileUserFilters(userFilters);
    }
    return { user: userCache };
}

// ---------------------------------------------------------------------------
// Applying settings
// ---------------------------------------------------------------------------
async function syncRulesets() {
    const [all, on] = await Promise.all([lists(), enabledLists()]);
    const onIds = new Set(on.map((l) => l.id));
    const current = new Set(await DNR.getEnabledRulesets());
    const rs = (l) => (l.dynamic ? [] : l.rulesets || [l.id]);   // a big list ships as several ruleset files
    const enableRulesetIds = all.filter((l) => onIds.has(l.id)).flatMap(rs).filter((id) => !current.has(id));
    const disableRulesetIds = all.filter((l) => !onIds.has(l.id)).flatMap(rs).filter((id) => current.has(id));
    if (enableRulesetIds.length || disableRulesetIds.length) {
        await DNR.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
    }
}

async function syncDynamicRules() {
    const [s, { user }] = await Promise.all([settings(), userData()]);
    const add = [];
    s.disabledSites.forEach((host, i) => add.push({
        id: SITE_RULE_BASE + i,
        priority: PRIORITY.siteDisabled,
        action: { type: 'allowAllRequests' },
        condition: { requestDomains: [host], resourceTypes: ['main_frame', 'sub_frame'] }
    }));
    if (s.enabled === false) add.push({
        id: GLOBAL_OFF_RULE,
        priority: PRIORITY.siteDisabled,
        action: { type: 'allowAllRequests' },
        condition: { resourceTypes: ['main_frame', 'sub_frame'] }
    });
    const tw = s.tweaks;
    const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];
    if (tw.gpc) add.push({
        id: TWEAK_RULE_BASE, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Sec-GPC', operation: 'set', value: '1' }, { header: 'DNT', operation: 'set', value: '1' }] },
        condition: { resourceTypes: ALL_TYPES }
    });
    if (tw.referrer) add.push({
        id: TWEAK_RULE_BASE + 1, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'remove' }] },
        condition: { domainType: 'thirdParty', resourceTypes: ALL_TYPES.filter((x) => x !== 'main_frame') }
    });
    const NON_FRAME = ['stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];
    if (tw.beacons) add.push({
        id: TWEAK_RULE_BASE + 2, priority: PRIORITY.block,
        action: { type: 'block' }, condition: { domainType: 'thirdParty', resourceTypes: ['ping'] }
    });
    if (tw.cookies3p) add.push({
        id: TWEAK_RULE_BASE + 3, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'remove' }], responseHeaders: [{ header: 'set-cookie', operation: 'remove' }] },
        condition: { domainType: 'thirdParty', resourceTypes: NON_FRAME }
    });
    if (tw.httpsOnly) add.push({
        id: TWEAK_RULE_BASE + 4, priority: 1,
        action: { type: 'upgradeScheme' },
        condition: { urlFilter: '|http://', resourceTypes: ['main_frame', 'sub_frame'], excludedRequestDomains: ['localhost', 'local', 'lan', 'home.arpa', 'internal', 'test', '127.0.0.1'] }
    });
    if (tw.blend) add.push({
        id: TWEAK_RULE_BASE + 5, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Accept-Language', operation: 'set', value: 'en-US,en;q=0.9' }] },
        condition: { resourceTypes: ALL_TYPES }
    });
    if (tw.replay) add.push({
        id: TWEAK_RULE_BASE + 6, priority: PRIORITY.block,
        action: { type: 'block' },
        condition: { requestDomains: REPLAY_DOMAINS, domainType: 'thirdParty', resourceTypes: NON_FRAME.concat('sub_frame') }
    });
    if (tw.hideShorts) add.push({
        id: TWEAK_RULE_BASE + 7, priority: PRIORITY.redirect,
        action: { type: 'redirect', redirect: { regexSubstitution: 'https://www.youtube.com/watch?v=\\1' } },
        condition: { regexFilter: '^https://(?:www\\.|m\\.)?youtube\\.com/shorts/([A-Za-z0-9_-]{6,20})', resourceTypes: ['main_frame'] }
    });
    // Lockdown mode: no scripts at all, and nothing active from other companies (images, styles and fonts still load)
    const LOCK_PRIORITY = PRIORITY.user + 5;   // beats list exceptions, loses to your own @@ filters
    s.lockedSites.slice(0, 300).forEach((host, i) => {
        const id = LOCK_RULE_BASE + i * 3;
        add.push(
            { id, priority: LOCK_PRIORITY, action: { type: 'block' }, condition: { initiatorDomains: [host], resourceTypes: ['script'] } },
            { id: id + 1, priority: LOCK_PRIORITY, action: { type: 'block' }, condition: { initiatorDomains: [host], domainType: 'thirdParty', resourceTypes: ['sub_frame', 'xmlhttprequest', 'websocket', 'ping', 'media', 'object', 'other'] } },
            { id: id + 2, priority: LOCK_PRIORITY, action: { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: "script-src 'none'; object-src 'none'; worker-src 'none'" }] }, condition: { requestDomains: [host], resourceTypes: ['main_frame', 'sub_frame'] } }
        );
    });
    if (tw.unwrap) {
        UNWRAP.forEach((p, i) => add.push({
            id: TWEAK_RULE_BASE + 20 + i, priority: PRIORITY.redirect,
            action: { type: 'redirect', redirect: { regexSubstitution: `${chrome.runtime.getURL('unwrap/unwrap.html')}#\\0` } },
            condition: { regexFilter: p.dnr, resourceTypes: ['main_frame'] }
        }));
    }
    if (tw.amp) add.push({
        id: TWEAK_RULE_BASE + 60, priority: PRIORITY.redirect,
        action: { type: 'redirect', redirect: { regexSubstitution: 'https://\\1' } },
        condition: { regexFilter: '^https?://(?:www\\.)?google\\.[a-z.]+/amp/s/(.+)$', resourceTypes: ['main_frame'] }
    });
    user.rules.forEach((r, i) => add.push({ ...r, id: USER_RULE_BASE + i }));
    // Fast fixes downloaded from the repo (network part)
    const hf = tw.hotfix ? await hotfixData() : null;
    (hf?.rules || []).slice(0, 2000).forEach((r, i) => add.push({ ...r, id: HOTFIX_RULE_BASE + i }));
    // Lists the Firefox build loads as dynamic rules (Firefox's static budget is 30k)
    let next = DYNAMIC_LIST_BASE;
    for (const l of await enabledLists()) {
        if (!l.dynamic) continue;
        for (const id of l.rulesets || [l.id]) for (const r of await json(`rulesets/${id}.json`)) add.push({ ...r, id: next++ });
    }
    const existing = (await DNR.getDynamicRules()).map((r) => r.id);
    try {
        await DNR.updateDynamicRules({ removeRuleIds: existing, addRules: add });
    } catch (err) {
        // A bad user rule shouldn't take the site allowlist down with it
        console.warn('dx.block: dynamic rules rejected, retrying without user filters', err);
        await DNR.updateDynamicRules({ removeRuleIds: existing, addRules: add.filter((r) => r.id < USER_RULE_BASE || r.id >= DYNAMIC_LIST_BASE) }).catch((e2) => logError('dynamic rules', e2));
        return String(err.message || err);
    }
    return null;
}

const OUR_PREFIX = 'dxb-';
async function syncContentScripts({ force = false } = {}) {
    const [reg, groups, s] = await Promise.all([registry(), enabledGroups(), settings()]);
    const wanted = reg.filter((r) => groups.has(r.group) && r.matches.length);
    const excludeMatches = s.disabledSites.flatMap(sitePatterns);
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const ours = existing.filter((r) => r.id.startsWith(OUR_PREFIX));
    if (s.enabled === false) {
        // main switch off: no page cleanup anywhere (registered again when it's switched back on)
        if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours.map((r) => r.id) });
        await chrome.storage.local.remove('scriptStamp');
        return;
    }
    // The pattern count catches a rebuilt registry under an unchanged version (unpacked installs)
    const stamp = `${chrome.runtime.getManifest().version}|${[...groups].sort().join(',')}|${wanted.reduce((n, r) => n + r.matches.length, 0)}`;
    const { scriptStamp } = await chrome.storage.local.get('scriptStamp');

    if (!force && scriptStamp === stamp && ours.length === wanted.length) {
        // Every registry write makes Chrome reprocess all registered patterns on the UI thread,
        // so skip it entirely when nothing changed (the normal case at browser startup)
        const same = ours.every((r) => (r.excludeMatches || []).join() === excludeMatches.join());
        if (same) return;
        // Only the allowlist changed: update excludeMatches in place
        const updates = ours.map((r) => ({ id: r.id, excludeMatches }));
        if (updates.length) await chrome.scripting.updateContentScripts(updates).catch(() => syncContentScripts({ force: true }));
        return;
    }
    if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours.map((r) => r.id) });
    const scripts = wanted.map((r) => ({
        id: OUR_PREFIX + r.id,
        js: r.js,
        matches: r.matches,
        excludeMatches,
        runAt: 'document_start',
        allFrames: true,
        ...(IS_FIREFOX ? {} : { matchOriginAsFallback: true }),
        world: r.world,
        persistAcrossSessions: true
    }));
    // One call: Chrome rewrites its whole script registry on every registration
    try {
        await chrome.scripting.registerContentScripts(scripts);
    } catch (err) {
        console.warn('dx.block: bulk registration failed, registering one by one', err);
        for (const s of scripts) await chrome.scripting.registerContentScripts([s]).catch((e) => console.warn('dx.block: could not register', s.id, e));
    }
    await chrome.storage.local.set({ scriptStamp: stamp });
}

// ---------------------------------------------------------------------------
// Update check (installs from the browser stores update themselves; this covers zip / unpacked installs)
// ---------------------------------------------------------------------------
const newer = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
};
async function checkForUpdate() {
    const { tweaks } = await settings();
    if (!tweaks.updateCheck) { await chrome.storage.local.remove('update'); return null; }
    try {
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' }, cache: 'no-store' });
        if (!r.ok) return null;
        const rel = await r.json();
        const version = String(rel.tag_name || '').replace(/^v/, '');
        const current = chrome.runtime.getManifest().version;
        const update = version && newer(version, current) ? { version, url: rel.html_url, at: Date.now() } : null;
        if (update) await chrome.storage.local.set({ update }); else await chrome.storage.local.remove('update');
        return update;
    } catch (e) { logError('update check', e); return null; }
}
chrome.alarms?.onAlarm.addListener((a) => { if (a.name === 'update-check') checkForUpdate(); });
chrome.alarms?.create('update-check', { delayInMinutes: 2, periodInMinutes: 24 * 60 });

// ---------------------------------------------------------------------------
// Privacy tweaks
// ---------------------------------------------------------------------------
const TWEAK_SCRIPTS = {
    gpc: { file: 'content/gpc.js', world: 'MAIN' },
    notifications: { file: 'content/no-notifications.js', world: 'MAIN' },
    fingerprint: { file: 'content/fingerprint.js', world: 'MAIN' },
    blend: { file: 'content/blend.js', world: 'MAIN' },
    sponsorblock: { file: 'content/sponsorblock.js', world: 'ISOLATED', matches: ['*://*.youtube.com/*'], allFrames: false },
    consent: { file: 'content/consent.js', world: 'ISOLATED' },
    darkPatterns: { file: 'content/darkpatterns.js', world: 'ISOLATED', allFrames: false },
    clipboard: { file: 'content/clipboard.js', world: 'MAIN' },
    searchGrades: { file: 'content/search-grades.js', world: 'ISOLATED', matches: searchMatches(), allFrames: false, runAt: 'document_idle' },
    hideAI: { file: 'content/hide-ai.js', world: 'ISOLATED', matches: searchMatches(), allFrames: false },
    hideShorts: { file: 'content/hide-shorts.js', world: 'ISOLATED', matches: ['*://*.youtube.com/*'], allFrames: false },
    hideEndscreens: { file: 'content/hide-endscreens.js', world: 'ISOLATED', matches: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'] },
    hideAmazonAds: { file: 'content/hide-amazon.js', world: 'ISOLATED', matches: amazonMatches(), allFrames: false }
};
function searchMatches() {
    const tlds = ['com', 'co.uk', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'ca', 'com.au', 'co.in', 'co.jp', 'com.br', 'com.mx', 'ie', 'se', 'no', 'dk', 'fi',
        'ch', 'at', 'be', 'pt', 'co.nz', 'com.tr', 'gr', 'cz', 'hu', 'ro', 'co.za', 'com.ar', 'cl', 'co.id', 'com.sg', 'com.hk', 'com.ua', 'ru'];
    return [...tlds.map((t) => `*://www.google.${t}/search*`), '*://www.bing.com/search*', '*://duckduckgo.com/*', '*://html.duckduckgo.com/*',
        '*://search.brave.com/search*', '*://www.startpage.com/*', '*://www.ecosia.org/search*'];
}
function amazonMatches() {
    return ['com', 'co.uk', 'de', 'fr', 'it', 'es', 'ca', 'com.au', 'co.jp', 'in', 'com.mx', 'com.br', 'nl', 'se', 'pl', 'com.tr', 'ae', 'sa', 'sg', 'com.be', 'eg', 'ie']
        .map((t) => `*://*.amazon.${t}/*`);
}
let proxyListener = null;
let proxyAuth = null;

async function applyTweaks() {
    const { tweaks: tw, disabledSites, enabled } = await settings();
    // WebRTC IP leak protection
    try {
        await chrome.privacy?.network?.webRTCIPHandlingPolicy?.set({ value: tw.webrtc ? 'disable_non_proxied_udp' : 'default' });
    } catch (e) { logError('webrtc', e); }

    // Page-side scripts (GPC flag, notification blocker)
    const registered = (await chrome.scripting.getRegisteredContentScripts()).filter((r) => r.id.startsWith('dxbt-'));
    const wanted = Object.entries(TWEAK_SCRIPTS).filter(([k]) => tw[k] && enabled !== false).map(([k, s]) => ({
        id: `dxbt-${k}`, js: [s.file], matches: s.matches || ['<all_urls>'], excludeMatches: disabledSites.flatMap(sitePatterns),
        runAt: s.runAt || 'document_start', allFrames: s.allFrames ?? true, world: s.world, persistAcrossSessions: true
    }));
    // Re-registering rewrites the whole script registry (slow), so only do it on a real change
    const key = (r) => JSON.stringify([r.id, r.js, r.matches, r.excludeMatches || [], r.allFrames, r.world, r.runAt]);
    const same = registered.length === wanted.length && registered.every((r) => wanted.some((w) => key(w) === key(r)));
    if (!same) {
        if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: registered.map((r) => r.id) }).catch(() => {});
        if (wanted.length) await chrome.scripting.registerContentScripts(wanted).catch((e) => logError('tweak scripts', e));
    }

    await applyProxy(tw.proxy);
}

async function applyProxy(p) {
    const on = p.mode !== 'off' && p.host && p.port;
    proxyAuth = on && p.user ? { username: p.user, password: p.pass || '' } : null;
    if (IS_FIREFOX) {
        // Firefox: decide per request
        if (proxyListener) { browser.proxy.onRequest.removeListener(proxyListener); proxyListener = null; }
        if (on) {
            const type = p.scheme === 'socks5' ? 'socks' : p.scheme === 'socks4' ? 'socks4' : p.scheme;
            proxyListener = () => ({ type, host: p.host, port: Number(p.port), proxyDNS: type.startsWith('socks'), ...(proxyAuth || {}) });
            browser.proxy.onRequest.addListener(proxyListener, { urls: ['<all_urls>'] });
        }
        return;
    }
    if (!chrome.proxy?.settings) return;
    try {
        if (on) {
            await chrome.proxy.settings.set({
                scope: 'regular',
                value: { mode: 'fixed_servers', rules: { singleProxy: { scheme: p.scheme, host: p.host, port: Number(p.port) }, bypassList: ['localhost', '127.0.0.1', '[::1]', '<local>'] } }
            });
        } else {
            const cur = await chrome.proxy.settings.get({});
            if (cur.levelOfControl === 'controlled_by_this_extension') await chrome.proxy.settings.clear({ scope: 'regular' });
        }
    } catch (e) { logError('proxy', e); }
}

// Proxy username/password
chrome.webRequest.onAuthRequired?.addListener((d, done) => {
    if (d.isProxy && proxyAuth) { done?.({ authCredentials: proxyAuth }); return { authCredentials: proxyAuth }; }
    done?.({});
    return {};
}, { urls: ['<all_urls>'] }, [IS_FIREFOX ? 'blocking' : 'asyncBlocking']);

async function syncAll(force = false) {
    await ensureRedirects();
    await syncRulesets().catch((e) => logError('rulesets', e));
    await syncDynamicRules().catch((e) => logError('dynamic rules', e));
    await syncContentScripts({ force }).catch((e) => logError('content scripts', e));
    await DNR.setExtensionActionOptions?.({ displayActionCountAsBadgeText: false })?.catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ color: '#e50914' }).catch(() => {});
    await chrome.action.setBadgeTextColor?.({ color: '#ffffff' }).catch?.(() => {});
    await applyTweaks().catch((e) => logError('tweaks', e));
    fetchHotfix();
    settings().then((s) => s.tweaks.siteBreaches && breachData()).catch(() => {});
    await chrome.storage.session.set({ ready: Date.now() });
}
// The proxy listener (Firefox) and auth cache live in memory: restore them whenever the worker starts
settings().then((s) => applyProxy(s.tweaks.proxy)).catch(() => {});

// ---------------------------------------------------------------------------
// Cosmetics for a frame
// ---------------------------------------------------------------------------
async function cosmeticInit(url, topUrl) {
    const host = hostOf(url);
    if (await isDisabled(hostOf(topUrl) || host)) return { off: true };
    const [groups, f] = await Promise.all([enabledGroups(), flags()]);
    const chain = hostChain(host);
    const genericOn = !chain.some((d) => f.generichide[d]);
    let css = '';
    if (genericOn) {
        for (const g of groups) {
            const data = await generic(g);
            const exc = new Set(chain.flatMap((d) => data.exc[d] || []));
            for (const sel of data.high) if (!exc.has(sel)) css += `${sel}{display:none!important}\n`;
        }
    }
    return { off: false, generic: genericOn, css };
}

async function cosmeticTokens(url, tokens) {
    const host = hostOf(url);
    const chain = hostChain(host);
    const groups = await enabledGroups();
    let css = '';
    for (const g of groups) {
        const data = await generic(g);
        const exc = new Set(chain.flatMap((d) => data.exc[d] || []));
        for (const t of tokens) {
            const v = data.keys[t];
            if (!v) continue;
            for (const sel of (v === 1 ? [t] : v)) if (!exc.has(sel)) css += `${sel}{display:none!important}\n`;
        }
    }
    return css;
}

const applied = new Map();   // tabId -> selectors injected by onNavigation (for the "elements hidden" count)

// At navigation: entity filters (google.*), user filters, and scriptlets the static scripts can't cover
async function onNavigation(details) {
    const { tabId, frameId, url } = details;
    if (!/^https?:/.test(url)) return;
    const host = hostOf(url);
    let topHost = host;
    if (frameId !== 0) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        topHost = hostOf(tab?.url || '') || host;
    }
    if (await isDisabled(topHost)) return;

    const chain = hostChain(host);
    const ents = entityChain(host);
    const keys = [...chain, ...ents];
    const [groups, { user }, f] = await Promise.all([enabledGroups(), userData(), flags()]);
    const target = { tabId, frameIds: [frameId] };

    let css = '';
    const ext = [];
    const calls = [];
    // Site-specific hiding, style fixes and procedural rules from the lists
    if (!chain.some((d) => f.specifichide[d])) {
        for (const g of groups) {
            const data = await sites(g, host);
            const hide = new Set();
            const exc = new Set();
            const rules = new Set();
            const styles = [];
            for (const d of chain) {
                const e = data[d];
                if (!e) continue;
                e.h?.forEach((s) => hide.add(s));
                e.x?.forEach((s) => exc.add(s));
                e.r?.forEach((s) => rules.add(s));
                if (e.c) styles.push(...e.c);
            }
            for (const s of hide) if (!exc.has(s)) css += `${s}{display:none!important}\n`;
            for (const s of styles) if (!exc.has(s)) css += `${s}\n`;
            for (const r of rules) if (!exc.has(r)) ext.push(r);
        }
    }
    for (const g of groups) {
        const e = await entity(g);
        for (const k of ents) {
            for (const sel of e.hide[k] || []) css += `${sel}{display:none!important}\n`;
            for (const rule of e.css[k] || []) css += `${rule}\n`;
            ext.push(...(e.ext[k] || []));
            calls.push(...(e.scriptlets[k] || []));
        }
    }
    const hfc = (await settings()).tweaks.hotfix ? (await hotfixData()).cosmetic : null;
    if (hfc) {
        for (const sel of hfc.genericHide) css += `${sel}{display:none!important}\n`;
        for (const k of keys) {
            for (const sel of hfc.hide[k] || []) css += `${sel}{display:none!important}\n`;
            for (const rule of hfc.css[k] || []) css += `${rule}\n`;
            ext.push(...(hfc.ext[k] || []));
        }
    }
    const uc = user.cosmetic;
    const uexc = new Set(keys.flatMap((k) => uc.exc[k] || []));
    if (!uexc.has('*')) {
        for (const sel of uc.genericHide) if (!uexc.has(sel)) css += `${sel}{display:none!important}\n`;
        for (const k of keys) {
            for (const sel of uc.hide[k] || []) if (!uexc.has(sel)) css += `${sel}{display:none!important}\n`;
            for (const rule of uc.css[k] || []) css += `${rule}\n`;
            ext.push(...(uc.ext[k] || []));
            calls.push(...(uc.js[k] || []));
        }
    }

    // uBO ":matches-path()" rules: keep the ones whose path matches this page, then strip the pseudo-class
    const pathAndQuery = (() => { try { const u = new URL(url); return u.pathname + u.search; } catch { return '/'; } })();
    for (let i = ext.length - 1; i >= 0; i--) {
        const m = /:matches-path\((.+?)\)(?=$|[\s>+~.#[:])/.exec(ext[i]);
        if (!m) continue;
        const arg = m[1];
        let ok;
        try { ok = arg.startsWith('/') && arg.length > 2 && arg.endsWith('/') ? new RegExp(arg.slice(1, -1)).test(pathAndQuery) : pathAndQuery.includes(arg); } catch { ok = false; }
        const rest = ext[i].replace(m[0], '').trim();
        ext.splice(i, 1);
        if (!ok || !rest) continue;
        if (/:(?:-abp-|has-text|contains|matches-|xpath|nth-ancestor|upward|remove|min-text-length)/.test(rest) || /\{[^{}]*\}\s*$/.test(rest)) ext.push(rest);
        else css += `${rest}{display:none!important}\n`;
    }

    if (css) {
        chrome.scripting.insertCSS({ target, css, origin: 'USER' }).catch(() => {});
        const sels = css.split('\n').map((l) => l.endsWith('{display:none!important}') ? l.slice(0, -24) : null).filter(Boolean);
        applied.set(tabId, [...new Set([...(frameId === 0 ? [] : applied.get(tabId) || []), ...sels])].slice(0, 4000));
    } else if (frameId === 0) {
        applied.delete(tabId);
    }
    for (const [name, args] of calls) {
        const fn = SCRIPTLETS[name];
        if (!fn) continue;
        chrome.scripting.executeScript({
            target, world: 'MAIN', injectImmediately: true, func: fn,
            args: [{ name, args, engine: 'extension', version: SCRIPTLETS_VERSION, verbose: false, ruleText: '' }, args]
        }).catch(() => {});
    }
    if (ext.length) {
        chrome.scripting.executeScript({ target, files: ['lib/extended-css.js'], injectImmediately: true })
            .then(() => chrome.scripting.executeScript({
                target, injectImmediately: true, args: [ext],
                func: (rules) => {
                    const list = rules.map((r) => (/\{[^{}]*\}\s*$/.test(r) ? r : `${r} { display: none !important; }`));
                    // eslint-disable-next-line no-undef
                    const ok = list.filter((r) => { try { return ExtendedCss.validate(r.replace(/\s*\{[^{}]*\}\s*$/, '')).ok; } catch { return false; } });
                    // eslint-disable-next-line no-undef
                    if (ok.length) new ExtendedCss({ cssRules: ok }).apply();
                }
            }))
            .catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Pop-up blocker (DNR can't do this; uBO-style tab closing)
// ---------------------------------------------------------------------------
const popupCandidates = new Map();   // tabId -> { openerHost, at }

// sourceHost: the frame that opened the pop-up (an ad iframe opening a pop-up is always an ad)
async function popupBlocked(targetUrl, openerHost, sourceHost = '') {
    if (!/^https?:/.test(targetUrl) || !openerHost) return false;
    if (await isDisabled(openerHost)) return false;
    const filters = await getPopupFilters();
    const chain = hostChain(openerHost);
    const targetHost = hostOf(targetUrl);
    const thirdParty = baseOf(targetHost) !== baseOf(openerHost);
    let blocked = false;
    for (const p of filters) {
        if (p.t === 3 && !thirdParty) continue;
        if (p.t === 1 && thirdParty) continue;
        if (p.d && !p.d.some((d) => chain.includes(d))) continue;
        if (p.xd && p.xd.some((d) => chain.includes(d))) continue;
        if (!p.rx.test(targetUrl)) continue;
        if (p.allow) return false;
        blocked = true;
    }
    if (blocked || !thirdParty) return blocked;
    // Known ad servers, malware and scam domains
    const ads = await popupDomains();
    if (hostChain(targetHost).some((d) => ads.has(d))) return true;
    if (sourceHost && sourceHost !== openerHost && hostChain(sourceHost).some((d) => ads.has(d))) return true;
    return false;
}

function closePopup(tabId, openerTabId, url) {
    chrome.tabs.remove(tabId).catch(() => {});
    stats.record(openerTabId, 'popup', url);
}

chrome.webNavigation.onCreatedNavigationTarget.addListener(async (d) => {
    const [opener, frame] = await Promise.all([
        chrome.tabs.get(d.sourceTabId).catch(() => null),
        d.sourceFrameId ? chrome.webNavigation.getFrame({ tabId: d.sourceTabId, frameId: d.sourceFrameId }).catch(() => null) : null
    ]);
    const openerHost = hostOf(opener?.url || '');
    const sourceHost = hostOf(frame?.url || '');
    popupCandidates.set(d.tabId, { openerHost, sourceHost, opener: d.sourceTabId, at: Date.now() });
    setTimeout(() => popupCandidates.delete(d.tabId), 10_000);
    if (await popupBlocked(d.url, openerHost, sourceHost)) { popupCandidates.delete(d.tabId); closePopup(d.tabId, d.sourceTabId, d.url); }
});

chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
    if (d.frameId !== 0) return;
    const c = popupCandidates.get(d.tabId);
    if (!c || Date.now() - c.at > 10_000) return;
    if (await popupBlocked(d.url, c.openerHost, c.sourceHost)) {
        popupCandidates.delete(d.tabId);
        closePopup(d.tabId, c.opener, d.url);
    }
});

// ---------------------------------------------------------------------------
// Counting what DNR blocked (observe-only webRequest) + the blocked-page warning
// ---------------------------------------------------------------------------
const EXT_ORIGIN = chrome.runtime.getURL('');
const blockedPages = new Map();   // tabId -> URL shown on the warning page

const seenErrors = {};   // error string -> count (Diagnostics)
const BLOCKED_ERRORS = new Set(['net::ERR_BLOCKED_BY_CLIENT', 'NS_ERROR_BLOCKED_BY_POLICY', 'NS_ERROR_CONTENT_BLOCKED']);
chrome.webRequest.onErrorOccurred.addListener((d) => {
    seenErrors[d.error] = (seenErrors[d.error] || 0) + 1;
    if (d.tabId < 0) return;
    if (d.error === 'NS_ERROR_ABORT' && IS_FIREFOX) { firefoxBlocked(d); return; }
    if (!BLOCKED_ERRORS.has(d.error)) return;
    if (d.type === 'main_frame') {
        blockedPages.set(d.tabId, d.url);
        stats.record(d.tabId, 'threat', d.url);
        chrome.tabs.update(d.tabId, { url: `${EXT_ORIGIN}blocked/blocked.html#${encodeURIComponent(d.url)}` }).catch(() => {});
        return;
    }
    stats.record(d.tabId, stats.kindOf(d.url), d.url);
}, { urls: ['<all_urls>'] });

// Firefox reports DNR blocks as NS_ERROR_ABORT, like any cancelled request: confirm with DNR before counting
const FF_TYPES = { beacon: 'ping', imageset: 'image', object_subrequest: 'object', xml_dtd: 'other', xslt: 'other', web_manifest: 'other', speculative: 'other' };
async function firefoxBlocked(d) {
    try {
        const r = await DNR.testMatchOutcome({ url: d.url, type: FF_TYPES[d.type] || d.type, initiator: d.originUrl || d.documentUrl, tabId: d.tabId });
        if (!r.matchedRules?.length) return;
    } catch { /* testMatchOutcome unavailable: count it */ }
    if (d.type === 'main_frame') return;
    stats.record(d.tabId, stats.kindOf(d.url), d.url);
}

chrome.webRequest.onBeforeRedirect.addListener((d) => {
    if (d.tabId < 0) return;
    if (d.redirectUrl.startsWith(EXT_ORIGIN)) { stats.record(d.tabId, 'stealth', d.url); return; }
    // Query transform by a removeparam rule: same address, fewer parameters
    try {
        const a = new URL(d.url);
        const b = new URL(d.redirectUrl);
        if (a.origin === b.origin && a.pathname === b.pathname && b.search.length < a.search.length && /Internal Redirect/i.test(d.statusLine || '')) {
            stats.record(d.tabId, 'param', d.url);
        }
    } catch { /* ignore */ }
}, { urls: ['<all_urls>'] });

chrome.webNavigation.onCommitted.addListener(async (d) => {
    if (d.frameId !== 0) return;
    if (d.url.startsWith(EXT_ORIGIN)) return;          // our own warning page keeps the counts
    stats.resetTab(d.tabId, d.url);
    if (await isDisabled(hostOf(d.url))) stats.setBadgeOff(d.tabId); else stats.setBadgeOn(d.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => { stats.removeTab(tabId); applied.delete(tabId); blockedPages.delete(tabId); });
chrome.runtime.onConnect.addListener((port) => { if (port.name === 'live') stats.attachPort(port); });

chrome.webNavigation.onCommitted.addListener((d) => { onNavigation(d).catch(() => {}); });

// ---------------------------------------------------------------------------
// Element picker
// ---------------------------------------------------------------------------
async function startPicker(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/picker.js'] });
}

async function addUserFilter(line) {
    const s = await settings();
    const text = s.userFilters.trimEnd() + (s.userFilters.trim() ? '\n' : '') + line + '\n';
    await saveUserFilters(text);
}

async function saveUserFilters(text) {
    await chrome.storage.local.set({ userFilters: text });
    userCache = await compileUserFilters(text);
    popupFilters = null;
    const err = await syncDynamicRules();
    return { ok: userCache.ok, errors: userCache.errors, ruleError: err };
}

// ---------------------------------------------------------------------------
// Fast fixes: a small filter file in the repo, fetched daily, so broken sites / new YouTube tricks get fixed
// without waiting for a release. Network + cosmetic filters only (no scriptlets): data, never code.
// ---------------------------------------------------------------------------
const HOTFIX_URL = `https://raw.githubusercontent.com/${REPO}/main/hotfix/hotfix.txt`;
let hotfixCache = null;
async function hotfixData() {
    if (hotfixCache) return hotfixCache;
    const { hotfix } = await chrome.storage.local.get('hotfix');
    const safe = (hotfix?.text || '').split('\n').filter((l) => !/#@?%#|\+js\(|#\$#/.test(l)).join('\n');
    hotfixCache = await compileUserFilters(safe);
    return hotfixCache;
}
async function fetchHotfix() {
    const { tweaks } = await settings();
    if (!tweaks.hotfix) return;
    try {
        const r = await fetch(HOTFIX_URL, { cache: 'no-store' });
        if (!r.ok) return;
        const text = (await r.text()).slice(0, 200_000);
        const { hotfix } = await chrome.storage.local.get('hotfix');
        if (hotfix?.text === text) return;
        await chrome.storage.local.set({ hotfix: { text, at: Date.now() } });
        hotfixCache = null;
        popupFilters = null;
        await syncDynamicRules();
    } catch (e) { logError('fast fixes', e); }
}
chrome.alarms?.onAlarm.addListener((a) => { if (a.name === 'hotfix') fetchHotfix(); });
chrome.alarms?.create('hotfix', { delayInMinutes: 1, periodInMinutes: 6 * 60 });

// ---------------------------------------------------------------------------
// Fake-site warning (look-alike domains) and HTTPS-only fallback
// ---------------------------------------------------------------------------
const trustedHosts = new Set();      // "Proceed anyway" for this browser session
const upgraded = new Map();          // tabId -> http URL that HTTPS-only upgraded

async function checkLookalike(d) {
    if (d.frameId !== 0 || !/^https?:/.test(d.url)) return;
    const host = hostOf(d.url);
    if (trustedHosts.has(host)) return;
    const { tweaks } = await settings();
    if (!tweaks.lookalike || await isDisabled(host)) return;
    const hit = lookalike(host, toUnicode(host));
    if (!hit) return;
    stats.event(d.tabId, 'phishing', host);
    blockedPages.set(d.tabId, d.url);
    const q = new URLSearchParams({ reason: 'lookalike', brand: hit.brand, real: hit.real, why: hit.reason, shown: toUnicode(host) });
    chrome.tabs.update(d.tabId, { url: `${EXT_ORIGIN}blocked/blocked.html?${q}#${encodeURIComponent(d.url)}` }).catch(() => {});
}
chrome.webNavigation.onBeforeNavigate.addListener((d) => { checkLookalike(d).catch(() => {}); });

chrome.webRequest.onBeforeRedirect.addListener((d) => {
    if (d.type === 'main_frame' && d.url.startsWith('http://') && d.redirectUrl.startsWith('https://') && /Internal Redirect/i.test(d.statusLine || '')) upgraded.set(d.tabId, d.url);
}, { urls: ['http://*/*'] });
chrome.webNavigation.onErrorOccurred.addListener(async (d) => {
    if (d.frameId !== 0) return;
    const http = upgraded.get(d.tabId);
    if (!http || hostOf(http) !== hostOf(d.url) || /ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(d.error)) return;
    upgraded.delete(d.tabId);
    // The site has no working HTTPS: allow plain HTTP for it this session
    const rules = await DNR.getSessionRules();
    const id = rules.reduce((n, r) => Math.max(n, r.id), 0) + 1;
    await DNR.updateSessionRules({ addRules: [{ id, priority: 2, action: { type: 'allow' }, condition: { requestDomains: [hostOf(http)], resourceTypes: ['main_frame', 'sub_frame'] } }] }).catch(() => {});
    chrome.tabs.update(d.tabId, { url: http }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Forget sites when you leave: cookies + storage of sites with no open tab (unless kept or allowlisted)
// ---------------------------------------------------------------------------
const tabSites = new Map();          // tabId -> base domain
const visited = new Set();           // base domains seen this session
function siteOf(url) { const h = hostOf(url); return /^https?:/.test(url) && h ? baseOf(h) : ''; }
async function forgetCheck() {
    const { tweaks, disabledSites } = await settings();
    if (!tweaks.forget) return;
    const open = new Set((await chrome.tabs.query({})).map((t) => siteOf(t.url || t.pendingUrl || '')).filter(Boolean));
    const keep = new Set([...tweaks.keepSites, ...disabledSites].map((s) => baseOf(s)));
    const gone = [...visited].filter((s) => !open.has(s) && !keep.has(s));
    if (!gone.length) return;
    const canCookies = await chrome.permissions.contains({ permissions: ['cookies'] }).catch(() => false);
    const canData = await chrome.permissions.contains({ permissions: ['browsingData'] }).catch(() => false);
    for (const site of gone) {
        visited.delete(site);
        try {
            if (canCookies) {
                for (const c of await chrome.cookies.getAll({ domain: site })) {
                    const url = `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path}`;
                    await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId }).catch(() => {});
                }
            }
            if (canData) {
                const types = { localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true };
                if (IS_FIREFOX) await chrome.browsingData.remove({ hostnames: [site, `www.${site}`] }, { localStorage: true, cookies: true }).catch(() => {});
                else await chrome.browsingData.remove({ origins: [`https://${site}`, `https://www.${site}`, `http://${site}`, `http://www.${site}`] }, types).catch(() => {});
            }
            stats.event(-1, 'cleaned', site);
        } catch (e) { logError('forget', e); }
    }
}
let forgetTimer = 0;
const scheduleForget = () => { clearTimeout(forgetTimer); forgetTimer = setTimeout(() => forgetCheck().catch(() => {}), 15_000); };
chrome.tabs.onRemoved.addListener(() => scheduleForget());
chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0) return;
    const site = siteOf(d.url);
    const prev = tabSites.get(d.tabId);
    if (site) { tabSites.set(d.tabId, site); visited.add(site); }
    if (prev && prev !== site) scheduleForget();
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
const handlers = {
    'cosmetic:init': (m, sender) => cosmeticInit(sender.url || m.url, sender.tab?.url || ''),
    'cosmetic:tokens': (m, sender) => cosmeticTokens(sender.url || m.url, m.tokens),

    // Must answer instantly (the popup renders from it), so nothing here waits on the page
    'popup:state': async ({ tabId }) => {
        await stats.restored;
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const url = tab?.url || tab?.pendingUrl || '';
        const host = hostOf(url);
        const [s, on, hasAccess] = await Promise.all([
            settings(), enabledLists(),
            chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }).catch(() => true)
        ]);
        return {
            host, url,
            web: /^https?:/.test(url),
            hasAccess,
            disabled: s.disabledSites.some((x) => hostChain(host).includes(x)),
            enabled: s.enabled !== false,
            allowedSites: s.disabledSites,
            locked: s.lockedSites.some((x) => hostChain(host).includes(x)),
            breaches: s.tweaks.siteBreaches && host ? breachesFor(host, breachIndexNow()).slice(0, 3) : [],
            stats: stats.summary(tabId),
            recent: stats.recent(tabId),
            top: stats.topHosts(tabId, 4),
            totals: await stats.totals(),
            lists: on.length,
            rules: on.reduce((n, l) => n + (l.filters || 0), 0),
            tweaks: s.tweaks,
            update: (await chrome.storage.local.get('update')).update || null
        };
    },
    'update:check': () => checkForUpdate(),
    'guard:init': async (m, sender) => {
        const host = hostOf(sender.tab?.url || sender.url || '');
        if (await isDisabled(host)) return { off: true };
        const { tweaks } = await settings();
        return { httpWarn: tweaks.httpWarn, amp: tweaks.amp, unwrap: tweaks.unwrap ? UNWRAP.map(({ re, params }) => ({ re, params })) : [] };
    },
    'guard:fp': ({ api }, sender) => { stats.event(sender.tab?.id ?? -1, 'fp', String(api).slice(0, 20)); return true; },
    'guard:event': ({ kind, detail }, sender) => {
        const map = { unwrap: 'unwrapped', amp: 'amp', sponsor: 'sponsor', 'insecure-password': 'phishing', consent: 'consent', clipboard: 'clipboard', dark: 'dark' };
        const withDetail = kind === 'dark' || kind === 'clipboard';
        if (map[kind]) stats.event(sender.tab?.id ?? -1, map[kind], withDetail ? String(detail || '').slice(0, 90) : hostOf(sender.tab?.url || ''));
        return true;
    },
    'grades:get': async ({ hosts }) => {
        const { tweaks } = await settings();
        if (!tweaks.searchGrades || !Array.isArray(hosts)) return {};
        hosts = hosts.slice(0, 60).map(String);
        const grades = await stats.gradesFor(hosts);
        const idx = tweaks.siteBreaches ? await breachIndex() : null;
        const out = {};
        for (const h of hosts) {
            const b = idx ? breachesFor(h, idx)[0] : null;
            if (grades[h] || b) out[h] = { grade: grades[h] || null, breach: b ? { title: b.title, date: b.date, count: b.count, classes: b.classes } : null };
        }
        return out;
    },
    'breach:list': async ({ refresh }) => (await breachData({ refresh: !!refresh })),
    'site:lock': async ({ host, on }) => {
        const s = await settings();
        const site = String(host || '').replace(/^www\./, '');
        if (!site) return s.lockedSites;
        let sites = s.lockedSites.filter((x) => !hostChain(host).includes(x));
        if (on) sites = [...sites, site];
        await chrome.storage.local.set({ lockedSites: [...new Set(sites)] });
        await syncDynamicRules();
        return sites;
    },
    'site:unlock': async ({ tabId }) => {
        await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: unlockPage }).catch(() => null);
        stats.event(tabId, 'clipboard', 'Copy, paste and right-click unlocked');
        return true;
    },
    'link:clean': async ({ url }) => cleanUrl(url),
    'blocked:trust': ({ url }) => { const h = hostOf(url); if (h) trustedHosts.add(h); return true; },
    'unwrap:bypass': async ({ url }) => {
        const host = hostOf(url);
        if (!host) return false;
        const rules = await DNR.getSessionRules();
        const id = rules.reduce((n, r) => Math.max(n, r.id), 0) + 1;
        await DNR.updateSessionRules({ addRules: [{ id, priority: PRIORITY.siteDisabled, action: { type: 'allow' }, condition: { requestDomains: [host], resourceTypes: ['main_frame'] } }] });
        setTimeout(() => DNR.updateSessionRules({ removeRuleIds: [id] }).catch(() => {}), 60_000);
        return true;
    },
    'site:permissions': async ({ tabId }) => {
        const res = await chrome.scripting.executeScript({
            target: { tabId }, injectImmediately: true,
            func: async () => {
                const out = {};
                for (const name of ['camera', 'microphone', 'geolocation', 'notifications']) {
                    try { out[name] = (await navigator.permissions.query({ name })).state; } catch { out[name] = 'unknown'; }
                }
                return out;
            }
        }).catch(() => null);
        return { perms: res?.[0]?.result || null, canRevoke: !!chrome.contentSettings || (!IS_FIREFOX) };
    },
    'site:revoke': async ({ url, name }) => {
        if (!chrome.contentSettings) return { error: 'needs-permission' };
        const pattern = `${new URL(url).origin}/*`;
        const key = { camera: 'camera', microphone: 'microphone', geolocation: 'location', notifications: 'notifications' }[name];
        if (!key || !chrome.contentSettings[key]) return { error: 'unsupported' };
        await chrome.contentSettings[key].set({ primaryPattern: pattern, setting: 'block' });
        return { ok: true };
    },
    'forget:now': async () => { visited.clear(); for (const t of await chrome.tabs.query({})) { const s = siteOf(t.url || ''); if (s) visited.add(s); } await forgetCheck(); return true; },
    'dashboard:state': async ({ tabId }) => ({
        stats: tabId != null ? stats.summary(tabId) : null,
        recent: tabId != null ? stats.recent(tabId) : [],
        top: tabId != null ? stats.topHosts(tabId, 12) : [],
        totals: await stats.totals(),
        history: await stats.history(),
        host: tabId != null ? hostOf((await chrome.tabs.get(tabId).catch(() => null))?.url || '') : ''
    }),
    'hotfix:info': async () => ({ ...(await chrome.storage.local.get('hotfix')).hotfix, rules: (await hotfixData()).ok }),
    // Elements hidden on the page: injected immediately (doesn't wait for the page to finish loading)
    'popup:hidden': async ({ tabId }) => {
        const count = chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            injectImmediately: true,
            args: [applied.get(tabId) || []],
            func: (specific) => {
                const els = new Set();
                for (const sel of [...specific, ...(window.__dxbApplied || [])]) {
                    try { for (const e of document.querySelectorAll(sel)) els.add(e); } catch { /* invalid here */ }
                    if (els.size > 9999) break;
                }
                return els.size;
            }
        }).then((res) => res.reduce((n, r) => n + (r.result || 0), 0)).catch(() => null);
        return Promise.race([count, new Promise((r) => setTimeout(() => r(null), 700))]);
    },
    'blocked:info': (m, sender) => ({ url: blockedPages.get(sender.tab?.id) || '' }),
    'blocked:proceed': async ({ url }) => {
        const host = hostOf(url);
        if (!host) return false;
        const rules = await DNR.getSessionRules();
        const id = rules.reduce((n, r) => Math.max(n, r.id), 0) + 1;
        await DNR.updateSessionRules({ addRules: [{ id, priority: PRIORITY.siteDisabled, action: { type: 'allow' }, condition: { requestDomains: [host], resourceTypes: ['main_frame'] } }] });
        return true;
    },
    'site:toggle': async ({ host, disabled }) => {
        const s = await settings();
        const site = host.replace(/^www\./, '');
        let sites = s.disabledSites.filter((x) => !hostChain(host).includes(x));
        if (disabled) sites = [...sites, site];
        await chrome.storage.local.set({ disabledSites: [...new Set(sites)] });
        await syncDynamicRules();
        await syncContentScripts();
        await applyTweaks();
        return true;
    },
    'picker:start': ({ tabId }) => startPicker(tabId),
    'picker:create': async ({ selector }, sender) => {
        const host = hostOf(sender.tab?.url || '').replace(/^www\./, '');
        await addUserFilter(`${host}##${selector}`);
        if (sender.tab) {
            await chrome.scripting.insertCSS({
                target: { tabId: sender.tab.id, allFrames: true }, origin: 'USER',
                css: `${selector}{display:none!important}`
            }).catch(() => {});
        }
        return true;
    },

    'options:get': async () => {
        const [all, s, on] = await Promise.all([lists(), settings(), enabledLists()]);
        const available = await DNR.getAvailableStaticRuleCount().catch(() => null);
        return {
            lists: all, enabled: on.map((l) => l.id), on: s.enabled !== false, disabledSites: s.disabledSites, userFilters: s.userFilters,
            available, version: chrome.runtime.getManifest().version, totals: await stats.totals(), tweaks: s.tweaks
        };
    },
    'options:set-list': async ({ id, on }) => {
        const [s, all] = await Promise.all([settings(), lists()]);
        s.lists[id] = on;
        await chrome.storage.local.set({ lists: s.lists });
        try {
            await syncRulesets();
            if (all.find((l) => l.id === id)?.dynamic) await syncDynamicRules();
        } catch (err) {
            s.lists[id] = !on;
            await chrome.storage.local.set({ lists: s.lists });
            return { error: String(err.message || err) };
        }
        await syncContentScripts();
        return { ok: true };
    },
    'options:save-filters': ({ text }) => saveUserFilters(text),
    'tweaks:set': async ({ tweaks }) => {
        const s = await settings();
        const next = { ...s.tweaks, ...tweaks, proxy: { ...s.tweaks.proxy, ...(tweaks.proxy || {}) } };
        await chrome.storage.local.set({ tweaks: next });
        await syncDynamicRules();
        await applyTweaks();
        return next;
    },
    'diagnostics': async () => {
        const [rulesets, dynamic, session, scripts, access, s] = await Promise.all([
            DNR.getEnabledRulesets(), DNR.getDynamicRules(), DNR.getSessionRules(),
            chrome.scripting.getRegisteredContentScripts(), chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }).catch(() => null), settings()
        ]);
        const available = await DNR.getAvailableStaticRuleCount().catch(() => null);
        let webrtc = null;
        try { webrtc = (await chrome.privacy?.network?.webRTCIPHandlingPolicy?.get({}))?.value ?? null; } catch { /* ignore */ }
        let proxy = null;
        try { proxy = IS_FIREFOX ? (proxyListener ? 'active (per-request)' : 'off') : (await chrome.proxy?.settings?.get({}))?.value?.mode ?? null; } catch { /* ignore */ }
        return {
            version: chrome.runtime.getManifest().version, browser: navigator.userAgent, firefox: IS_FIREFOX,
            hostAccess: access, rulesets: rulesets.length, rulesetIds: rulesets, dynamicRules: dynamic.length, sessionRules: session.length,
            contentScripts: scripts.length, staticRuleRoom: available, webrtc, proxy,
            totals: await stats.totals(), allowedSites: s.disabledSites.length, userFilterLines: s.userFilters.split('\n').filter((l) => l.trim()).length,
            errors, requestErrors: seenErrors,
            limits: Object.fromEntries(Object.entries(DNR).filter(([k, v]) => /^[A-Z_]+$/.test(k) && typeof v === 'number'))
        };
    },
    'global:toggle': async ({ enabled }) => {
        await chrome.storage.local.set({ enabled: !!enabled });
        await syncDynamicRules();
        await syncContentScripts({ force: true });
        await applyTweaks();
        for (const t of await chrome.tabs.query({})) {
            if (!enabled || await isDisabled(hostOf(t.url || ''))) stats.setBadgeOff(t.id); else stats.setBadgeOn(t.id);
        }
        return true;
    },
    'sites:add': async ({ host }) => {
        const s = await settings();
        return handlers['options:set-sites']({ sites: [...s.disabledSites, host] });
    },
    'sites:remove': async ({ host }) => {
        const s = await settings();
        return handlers['options:set-sites']({ sites: s.disabledSites.filter((x) => x !== host) });
    },
    'options:set-sites': async ({ sites }) => {
        const clean = [...new Set(sites.map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')).filter(Boolean))];
        await chrome.storage.local.set({ disabledSites: clean });
        await syncDynamicRules();
        await syncContentScripts();
        await applyTweaks();
        return clean;
    }
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    const h = handlers[msg?.type];
    if (!h) return false;
    Promise.resolve(h(msg, sender)).then(reply, (err) => reply({ error: String(err?.message || err) }));
    return true;
});

// ---------------------------------------------------------------------------
// Data breaches: Have I Been Pwned's public list of breached sites (no account, no personal data sent),
// downloaded once a week and kept locally for the popup, the search badges and the Settings page
// ---------------------------------------------------------------------------
const BREACH_URL = 'https://haveibeenpwned.com/api/v3/breaches';
let breachMem = null;
let breachIdx = null;
const stripHtml = (h) => String(h || '').replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
async function breachData({ refresh = false } = {}) {
    if (!breachMem) breachMem = (await chrome.storage.local.get('breaches')).breaches || { t: 0, list: [] };
    const stale = Date.now() - (breachMem.t || 0) > 7 * 24 * 3600e3;
    if (!refresh && !stale) return breachMem;
    try {
        const r = await fetch(BREACH_URL, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const list = (await r.json()).filter((b) => !b.IsFabricated).map((b) => ({
            name: b.Name, title: b.Title, domain: String(b.Domain || '').toLowerCase(), date: b.BreachDate, count: b.PwnCount,
            classes: b.DataClasses || [], verified: !!b.IsVerified, spam: !!b.IsSpamList, desc: stripHtml(b.Description).slice(0, 1500)
        }));
        breachMem = { t: Date.now(), list };
        breachIdx = null;
        await chrome.storage.local.set({ breaches: breachMem });
    } catch (e) { logError('breach list', e); }
    return breachMem;
}
function indexOf(data) {
    const idx = new Map();
    for (const b of data.list) if (b.domain) (idx.get(b.domain) || idx.set(b.domain, []).get(b.domain)).push(b);
    // Real, verified breaches first (scraped and spam lists after), newest first
    const rank = (b) => (b.verified ? 0 : 2) + (b.spam ? 1 : 0);
    for (const arr of idx.values()) arr.sort((a, b) => rank(a) - rank(b) || (b.date || '').localeCompare(a.date || ''));
    return idx;
}
async function breachIndex() {
    if (!breachIdx) breachIdx = indexOf(await breachData());
    return breachIdx;
}
function breachIndexNow() {          // never waits (the popup must answer instantly)
    if (!breachIdx && breachMem) breachIdx = indexOf(breachMem);
    if (!breachMem) breachData().catch(() => {});
    return breachIdx || new Map();
}
function breachesFor(host, idx) {
    for (const d of hostChain(String(host).replace(/^www\./, ''))) { const hit = idx.get(d); if (hit) return hit; }
    return [];
}
chrome.alarms?.onAlarm.addListener((a) => { if (a.name === 'breaches') settings().then((s) => s.tweaks.siteBreaches && breachData()); });
chrome.alarms?.create('breaches', { delayInMinutes: 3, periodInMinutes: 24 * 60 });

// ---------------------------------------------------------------------------
// Copy clean link: tracking redirects skipped, tracking parameters removed
// ---------------------------------------------------------------------------
const EXTRA_PARAMS = ['si', 'igsh', 'igshid', 'ref_src', 'ref_url', 'feature', 'pp', 'mibextid', 'rdt', 'share_id', 'smid', '_branch_match_id', '_branch_referrer', 'sh', '__tn__', 'trk', 'trackingId', 'refId', 'spm', 'scm', 'share_source', 'utm_name'];
async function cleanUrl(raw) {
    let url = String(raw || '');
    for (const p of UNWRAP) {
        if (!new RegExp(p.re, 'i').test(url)) continue;
        try {
            const u = new URL(url);
            for (const name of p.params) {
                const v = name === '*' ? decodeURIComponent(u.search.slice(1)) : u.searchParams.get(name);
                if (v && /^https?:\/\//i.test(v)) { url = v; break; }
            }
        } catch { /* keep */ }
    }
    let u;
    try { u = new URL(url); } catch { return url; }
    const known = new Set([...(await json('data/params.json').catch(() => [])), ...EXTRA_PARAMS].map((x) => String(x).toLowerCase()));
    if (/(^|\.)(x|twitter)\.com$/.test(u.hostname)) { known.add('s'); known.add('t'); }
    for (const k of [...u.searchParams.keys()]) if (known.has(k.toLowerCase()) || /^(utm_|mc_|pk_|hsa_|oly_|vero_|_hs)/i.test(k)) u.searchParams.delete(k);
    // Amazon product links: just /dp/<id>
    const asin = /(^|\.)amazon\./.test(u.hostname) && u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
    if (asin) return `${u.origin}/dp/${asin[1]}`;
    if (/\/ref=[^/]*$/.test(u.pathname)) u.pathname = u.pathname.replace(/\/ref=[^/]*$/, '');
    return u.href.replace(/\?(#|$)/, '$1');
}
// Runs in the page: copy, then show a small confirmation
function copyAndTell(text, changed) {
    const done = (ok) => {
        const host = document.createElement('dxblock-toast');
        host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%)';
        const root = host.attachShadow({ mode: 'closed' });
        root.innerHTML = '<style>div{font:13px/1.4 system-ui,sans-serif;color:#f4f4f6;background:#121216;border:1px solid rgba(229,9,20,.45);border-radius:12px;padding:9px 14px;box-shadow:0 12px 32px rgba(0,0,0,.5);max-width:520px}b{color:#ff4d57}small{display:block;color:#8d8d99;word-break:break-all;margin-top:2px;user-select:all}</style><div><b>dx.block</b> <span></span><small></small></div>';
        root.querySelector('span').textContent = ok ? (changed ? 'Clean link copied (trackers removed)' : 'Link copied (it had no trackers)') : 'Couldn’t copy. Select the link below:';
        root.querySelector('small').textContent = text;
        (document.body || document.documentElement).appendChild(host);
        setTimeout(() => host.remove(), ok ? 3500 : 12000);
    };
    const legacy = () => {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
        document.documentElement.appendChild(ta); ta.select();
        let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
        ta.remove(); done(ok);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), legacy); else legacy();
}
// Runs in the page: let the user copy, paste, select and right-click again
function unlockPage() {
    if (window.__dxbUnlocked) return true;
    window.__dxbUnlocked = true;
    const stop = (e) => e.stopImmediatePropagation();
    for (const t of ['copy', 'cut', 'paste', 'contextmenu', 'selectstart', 'dragstart']) window.addEventListener(t, stop, true);
    window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && /^[acvx]$/i.test(e.key)) e.stopImmediatePropagation(); }, true);
    for (const el of document.querySelectorAll('[oncopy],[oncut],[onpaste],[oncontextmenu],[onselectstart],[ondragstart]')) {
        for (const a of ['oncopy', 'oncut', 'onpaste', 'oncontextmenu', 'onselectstart', 'ondragstart']) el.removeAttribute(a);
    }
    const st = document.createElement('style');
    st.textContent = '*, *::before, *::after { -webkit-user-select: text !important; user-select: text !important; -webkit-touch-callout: default !important; }';
    (document.head || document.documentElement).appendChild(st);
    return true;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function setupMenus() {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: 'pick', title: 'Block element…', contexts: ['page', 'image', 'frame', 'link', 'video'] });
        chrome.contextMenus.create({ id: 'clean-link', title: 'Copy clean link', contexts: ['link'] });
        chrome.contextMenus.create({ id: 'clean-page', title: 'Copy clean link to this page', contexts: ['page'] });
    });
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'pick' && tab?.id) startPicker(tab.id).catch(() => {});
    if ((info.menuItemId === 'clean-link' || info.menuItemId === 'clean-page') && tab?.id) {
        const raw = info.menuItemId === 'clean-link' ? info.linkUrl : (info.pageUrl || tab.url);
        cleanUrl(raw).then((url) => chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [info.frameId || 0] }, func: copyAndTell, args: [url, url !== raw]
        })).catch((e) => logError('clean link', e));
    }
});
chrome.commands.onCommand.addListener(async (cmd, tab) => {
    if (cmd === 'pick-element' && tab?.id) startPicker(tab.id).catch(() => {});
});

chrome.runtime.onInstalled.addListener((d) => {
    setupMenus();
    syncAll(true);
    if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
});
chrome.runtime.onStartup.addListener(() => syncAll(false));
