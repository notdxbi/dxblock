// dx.block service worker
import {
    classify, convertNetworkFilter, convertCosmeticFilter, preprocess, registerRedirect, PRIORITY, bucketOf
} from './lib/filters.js';
import { S as SCRIPTLETS, ALIASES, VERSION as SCRIPTLETS_VERSION } from './lib/scriptlet-lib.js';
import * as stats from './stats.js';

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
const SITE_RULE_BASE = 1;

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
        popupFilters = [...raw, ...user.popups].map((p) => {
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
    proxy: { mode: 'off', scheme: 'socks5', host: '127.0.0.1', port: 9050, user: '', pass: '' }
};
const DEFAULTS = { lists: {}, disabledSites: [], userFilters: '', tweaks: TWEAK_DEFAULTS };
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
const sitePatterns = (h) => [`*://${h}/*`, `*://*.${h}/*`];

async function isDisabled(host) {
    if (!host) return false;
    const { disabledSites } = await settings();
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
    user.rules.forEach((r, i) => add.push({ ...r, id: USER_RULE_BASE + i }));
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
    const stamp = `${chrome.runtime.getManifest().version}|${[...groups].sort().join(',')}`;
    const { scriptStamp } = await chrome.storage.local.get('scriptStamp');

    if (!force && scriptStamp === stamp && ours.length === wanted.length) {
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
const TWEAK_SCRIPTS = { gpc: 'content/gpc.js', notifications: 'content/no-notifications.js' };
let proxyListener = null;
let proxyAuth = null;

async function applyTweaks() {
    const { tweaks: tw, disabledSites } = await settings();
    // WebRTC IP leak protection
    try {
        await chrome.privacy?.network?.webRTCIPHandlingPolicy?.set({ value: tw.webrtc ? 'disable_non_proxied_udp' : 'default' });
    } catch (e) { logError('webrtc', e); }

    // Page-side scripts (GPC flag, notification blocker)
    const existing = (await chrome.scripting.getRegisteredContentScripts()).filter((r) => r.id.startsWith('dxbt-')).map((r) => r.id);
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing }).catch(() => {});
    const wanted = Object.entries(TWEAK_SCRIPTS).filter(([k]) => tw[k]).map(([k, file]) => ({
        id: `dxbt-${k}`, js: [file], matches: ['<all_urls>'], excludeMatches: disabledSites.flatMap(sitePatterns),
        runAt: 'document_start', allFrames: true, world: 'MAIN', persistAcrossSessions: true
    }));
    if (wanted.length) await chrome.scripting.registerContentScripts(wanted).catch((e) => logError('tweak scripts', e));

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
            host,
            web: /^https?:/.test(url),
            hasAccess,
            disabled: s.disabledSites.some((x) => hostChain(host).includes(x)),
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
            lists: all, enabled: on.map((l) => l.id), disabledSites: s.disabledSites, userFilters: s.userFilters,
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
// Lifecycle
// ---------------------------------------------------------------------------
function setupMenus() {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: 'pick', title: 'Block element…', contexts: ['page', 'image', 'frame', 'link', 'video'] });
    });
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'pick' && tab?.id) startPicker(tab.id).catch(() => {});
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
