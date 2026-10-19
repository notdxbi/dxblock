// Per-tab blocking statistics: the toolbar badge, the popup's counters and its live feed.
// Fed by webRequest observers in background.js (they only watch; blocking itself is done by DNR).

const tabs = new Map();          // tabId -> stats for the page currently shown in the tab
const ports = new Map();         // tabId -> Set of popup ports listening live
const badgeTimers = new Map();
let saveTimer = 0;
let totalsTimer = 0;
let pendingTotals = { blocked: 0, trackers: 0, popups: 0 };

const TRACKER_RE = /analytic|track|pixel|telemetry|metric|stats?[./-]|collect|beacon|insight|tagmanager|gtag|segment|mixpanel|hotjar|clarity|fbevents|matomo|piwik|amplitude|heap(?:analytics)?|fullstory|newrelic|nr-data|sentry|quantserve|scorecardresearch|chartbeat|optimizely|bat\.bing|connect\.facebook|ads-twitter|snap\.licdn|bounceexchange|crazyegg|mouseflow|smartlook|yandex\.ru\/(?:metrika|watch)|mc\.yandex|ophan\.|\blogs?[.-]|[./-]events?[./]|\brum[.-]|measure|monitor|sessioncam|permutive|bluekai|demdex|omtrdc|2o7\.net|everesttech|adobedtm|tealium|parsely|cxense|piano\.io|tinypass|branch\.io|appsflyer|adjust\.com|kochava|onesignal|pushwoosh|doubleverify|moatads|iasds|adsafeprotected/i;
const MALWARE_HINT = /\.(?:exe|apk|scr|msi|zip)(?:$|\?)/i;

export function kindOf(url) {
    if (TRACKER_RE.test(url)) return 'tracker';
    if (MALWARE_HINT.test(url)) return 'threat';
    return 'ad';
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const fresh = (url) => ({ host: hostOf(url), blocked: 0, ads: 0, trackers: 0, threats: 0, stealth: 0, params: 0, popups: 0, recent: [], since: Date.now() });

export function getTab(tabId) {
    let s = tabs.get(tabId);
    if (!s) { s = fresh(''); tabs.set(tabId, s); }
    return s;
}

export function resetTab(tabId, url) {
    tabs.set(tabId, fresh(url));
    updateBadge(tabId);
    broadcast(tabId, { type: 'reset', stats: summary(tabId) });
    scheduleSave();
}

export function removeTab(tabId) {
    tabs.delete(tabId);
    scheduleSave();
}

// kind: 'ad' | 'tracker' | 'threat' | 'stealth' | 'param' | 'popup'
export function record(tabId, kind, url) {
    if (tabId < 0) return;
    const s = getTab(tabId);
    const host = hostOf(url) || url;
    if (kind === 'param') s.params++;
    else if (kind === 'popup') { s.popups++; s.blocked++; pendingTotals.popups++; }
    else {
        s.blocked++;
        if (kind === 'tracker') { s.trackers++; pendingTotals.trackers++; }
        else if (kind === 'threat') s.threats++;
        else if (kind === 'stealth') { s.stealth++; s.ads++; }
        else s.ads++;
    }
    if (kind !== 'param') pendingTotals.blocked++;
    const ev = { kind, host, t: Date.now() };
    s.recent.unshift(ev);
    if (s.recent.length > 60) s.recent.length = 60;
    updateBadge(tabId);
    broadcast(tabId, { type: 'event', ev, stats: summary(tabId) });
    scheduleSave();
    scheduleTotals();
}

export function summary(tabId) {
    const { recent, ...rest } = getTab(tabId);
    return rest;
}
export function recent(tabId) {
    return getTab(tabId).recent;
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------
const fmt = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function updateBadge(tabId) {
    if (badgeTimers.has(tabId)) return;
    badgeTimers.set(tabId, setTimeout(() => {
        badgeTimers.delete(tabId);
        const n = tabs.get(tabId)?.blocked || 0;
        chrome.action.setBadgeText({ tabId, text: n ? fmt(n) : '' }).catch(() => {});
    }, 200));
}

export function setBadgeOff(tabId) {
    chrome.action.setBadgeText({ tabId, text: 'off' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#5b5b66' }).catch(() => {});
}
export function setBadgeOn(tabId) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#e50914' }).catch(() => {});
    updateBadge(tabId);
}

// ---------------------------------------------------------------------------
// Live feed to an open popup
// ---------------------------------------------------------------------------
export function attachPort(port) {
    port.onMessage.addListener((m) => {
        if (m?.type !== 'watch') return;
        const set = ports.get(m.tabId) || new Set();
        set.add(port);
        ports.set(m.tabId, set);
        port.onDisconnect.addListener(() => set.delete(port));
    });
}
function broadcast(tabId, msg) {
    const set = ports.get(tabId);
    if (!set?.size) return;
    for (const p of set) { try { p.postMessage(msg); } catch { set.delete(p); } }
}

// ---------------------------------------------------------------------------
// Persistence (the worker can be stopped at any time)
// ---------------------------------------------------------------------------
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = 0;
        const obj = {};
        for (const [id, s] of tabs) obj[id] = { ...s, recent: s.recent.slice(0, 30) };
        chrome.storage.session.set({ tabStats: obj }).catch(() => {});
    }, 1000);
}
function scheduleTotals() {
    if (totalsTimer) return;
    totalsTimer = setTimeout(async () => {
        totalsTimer = 0;
        const add = pendingTotals;
        pendingTotals = { blocked: 0, trackers: 0, popups: 0 };
        const { totals = { blocked: 0, trackers: 0, popups: 0, since: Date.now() } } = await chrome.storage.local.get('totals');
        for (const k of Object.keys(add)) totals[k] = (totals[k] || 0) + add[k];
        await chrome.storage.local.set({ totals });
    }, 4000);
}
export async function totals() {
    const { totals: t = { blocked: 0, trackers: 0, popups: 0, since: Date.now() } } = await chrome.storage.local.get('totals');
    return { ...t, blocked: t.blocked + pendingTotals.blocked, trackers: t.trackers + pendingTotals.trackers, popups: t.popups + pendingTotals.popups };
}

export const restored = chrome.storage.session.get('tabStats').then(({ tabStats }) => {
    for (const [id, s] of Object.entries(tabStats || {})) if (!tabs.has(Number(id))) tabs.set(Number(id), s);
}).catch(() => {});
