// dx.block service worker
import {
    classify, convertNetworkFilter, convertCosmeticFilter, preprocess, registerRedirect, PRIORITY, bucketOf
} from './lib/filters.js';
import { S as SCRIPTLETS, ALIASES, VERSION as SCRIPTLETS_VERSION } from './lib/scriptlet-lib.js';

const DNR = chrome.declarativeNetRequest;
const USER_RULE_BASE = 10_000;
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
const DEFAULTS = { lists: {}, disabledSites: [], userFilters: '' };
async function settings() {
    const s = await chrome.storage.local.get(DEFAULTS);
    return { ...DEFAULTS, ...s };
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
    const enableRulesetIds = all.filter((l) => onIds.has(l.id) && !current.has(l.id)).map((l) => l.id);
    const disableRulesetIds = all.filter((l) => !onIds.has(l.id) && current.has(l.id)).map((l) => l.id);
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
    user.rules.forEach((r, i) => add.push({ ...r, id: USER_RULE_BASE + i }));
    const existing = (await DNR.getDynamicRules()).map((r) => r.id);
    try {
        await DNR.updateDynamicRules({ removeRuleIds: existing, addRules: add });
    } catch (err) {
        // A bad user rule shouldn't take the site allowlist down with it
        console.warn('dx.block: dynamic rules rejected, retrying without user filters', err);
        await DNR.updateDynamicRules({ removeRuleIds: existing, addRules: add.filter((r) => r.id < USER_RULE_BASE) });
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
        matchOriginAsFallback: true,
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

async function syncAll(force = false) {
    await ensureRedirects();
    await syncRulesets().catch((e) => console.warn('dx.block: rulesets', e));
    await syncDynamicRules().catch((e) => console.warn('dx.block: dynamic rules', e));
    await syncContentScripts({ force }).catch((e) => console.warn('dx.block: content scripts', e));
    await DNR.setExtensionActionOptions({ displayActionCountAsBadgeText: true }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ color: '#e50914' }).catch(() => {});
    await chrome.action.setBadgeTextColor?.({ color: '#ffffff' }).catch?.(() => {});
    await chrome.storage.session.set({ ready: Date.now() });
}

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

    if (css) chrome.scripting.insertCSS({ target, css, origin: 'USER' }).catch(() => {});
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

async function popupBlocked(targetUrl, openerHost) {
    if (!/^https?:/.test(targetUrl) || !openerHost) return false;
    if (await isDisabled(openerHost)) return false;
    const filters = await getPopupFilters();
    const chain = hostChain(openerHost);
    const thirdParty = baseOf(hostOf(targetUrl)) !== baseOf(openerHost);
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
    return blocked;
}

chrome.webNavigation.onCreatedNavigationTarget.addListener(async (d) => {
    const opener = await chrome.tabs.get(d.sourceTabId).catch(() => null);
    const openerHost = hostOf(opener?.url || '');
    popupCandidates.set(d.tabId, { openerHost, at: Date.now() });
    setTimeout(() => popupCandidates.delete(d.tabId), 10_000);
    if (await popupBlocked(d.url, openerHost)) chrome.tabs.remove(d.tabId).catch(() => {});
});

chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
    if (d.frameId !== 0) return;
    const c = popupCandidates.get(d.tabId);
    if (!c || Date.now() - c.at > 10_000) return;
    if (await popupBlocked(d.url, c.openerHost)) {
        popupCandidates.delete(d.tabId);
        chrome.tabs.remove(d.tabId).catch(() => {});
    }
});

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

    'popup:state': async ({ tabId }) => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const host = hostOf(tab?.url || '');
        const s = await settings();
        const badge = await chrome.action.getBadgeText({ tabId }).catch(() => '');
        return {
            host,
            web: /^https?:/.test(tab?.url || ''),
            disabled: s.disabledSites.some((x) => hostChain(host).includes(x)),
            blocked: parseInt(badge, 10) || 0,
            lists: (await enabledLists()).length
        };
    },
    'site:toggle': async ({ host, disabled }) => {
        const s = await settings();
        const site = host.replace(/^www\./, '');
        let sites = s.disabledSites.filter((x) => !hostChain(host).includes(x));
        if (disabled) sites = [...sites, site];
        await chrome.storage.local.set({ disabledSites: [...new Set(sites)] });
        await syncDynamicRules();
        await syncContentScripts();
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
            available, version: chrome.runtime.getManifest().version
        };
    },
    'options:set-list': async ({ id, on }) => {
        const s = await settings();
        s.lists[id] = on;
        await chrome.storage.local.set({ lists: s.lists });
        try {
            await syncRulesets();
        } catch (err) {
            s.lists[id] = !on;
            await chrome.storage.local.set({ lists: s.lists });
            return { error: String(err.message || err) };
        }
        await syncContentScripts();
        return { ok: true };
    },
    'options:save-filters': ({ text }) => saveUserFilters(text),
    'options:set-sites': async ({ sites }) => {
        const clean = [...new Set(sites.map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')).filter(Boolean))];
        await chrome.storage.local.set({ disabledSites: clean });
        await syncDynamicRules();
        await syncContentScripts();
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
    if (d.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => syncAll(false));
