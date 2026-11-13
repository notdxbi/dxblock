// Per-tab blocking statistics: the toolbar badge, the popup's counters and its live feed.
// Fed by webRequest observers in background.js (they only watch; blocking itself is done by DNR).
import { companyOf } from './lib/companies.js';
import { replayOf } from './lib/replay.js';
import { grade } from './ui/graph.js';

const tabs = new Map();          // tabId -> stats for the page currently shown in the tab
const ports = new Map();         // tabId -> Set of popup ports listening live
const badgeTimers = new Map();
let saveTimer = 0;
let totalsTimer = 0;
const ZERO = () => ({ blocked: 0, trackers: 0, popups: 0, fp: 0, unwrapped: 0, amp: 0, sponsor: 0, cleaned: 0, phishing: 0, cookies: 0, replay: 0, dark: 0, consent: 0, clipboard: 0, companies: {} });
let pendingTotals = ZERO();

const TRACKER_RE = /analytic|track|pixel|telemetry|metric|stats?[./-]|collect|beacon|insight|tagmanager|gtag|segment|mixpanel|hotjar|clarity|fbevents|matomo|piwik|amplitude|heap(?:analytics)?|fullstory|newrelic|nr-data|sentry|quantserve|scorecardresearch|chartbeat|optimizely|bat\.bing|connect\.facebook|ads-twitter|snap\.licdn|bounceexchange|crazyegg|mouseflow|smartlook|yandex\.ru\/(?:metrika|watch)|mc\.yandex|ophan\.|\blogs?[.-]|[./-]events?[./]|\brum[.-]|measure|monitor|sessioncam|permutive|bluekai|demdex|omtrdc|2o7\.net|everesttech|adobedtm|tealium|parsely|cxense|piano\.io|tinypass|branch\.io|appsflyer|adjust\.com|kochava|onesignal|pushwoosh|doubleverify|moatads|iasds|adsafeprotected/i;
const MALWARE_HINT = /\.(?:exe|apk|scr|msi|zip)(?:$|\?)/i;

export function kindOf(url) {
    if (TRACKER_RE.test(url)) return 'tracker';
    if (MALWARE_HINT.test(url)) return 'threat';
    return 'ad';
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const fresh = (url) => ({ host: hostOf(url), blocked: 0, ads: 0, trackers: 0, threats: 0, stealth: 0, params: 0, popups: 0, fp: 0, fpApis: [], unwrapped: 0, amp: 0, sponsor: 0, replay: 0, replayBy: [], dark: 0, darkKinds: [], consent: 0, clipboard: 0, recent: [], hosts: {}, companies: {}, since: Date.now() });

export function getTab(tabId) {
    let s = tabs.get(tabId);
    if (!s) { s = fresh(''); tabs.set(tabId, s); }
    return s;
}

export function resetTab(tabId, url) {
    saveGrade(tabs.get(tabId));
    tabs.set(tabId, fresh(url));
    updateBadge(tabId);
    broadcast(tabId, { type: 'reset', stats: summary(tabId) });
    scheduleSave();
}

export function removeTab(tabId) {
    saveGrade(tabs.get(tabId));
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
    if (kind !== 'param') {
        s.hosts ||= {};
        s.hosts[host] = (s.hosts[host] || 0) + 1;
        const company = companyOf(host);
        if (company) {
            s.companies ||= {};
            s.companies[company] = (s.companies[company] || 0) + 1;
            pendingTotals.companies[company] = (pendingTotals.companies[company] || 0) + 1;
        }
    }
    const ev = { kind, host, t: Date.now(), company: companyOf(host) };
    const vendor = kind !== 'param' && replayOf(host, url);
    if (vendor && !(s.replayBy ||= []).includes(vendor)) { s.replayBy.push(vendor); s.replay = (s.replay || 0) + 1; pendingTotals.replay++; queueMicrotask(() => event(tabId, 'replay-alert', vendor)); }
    s.recent.unshift(ev);
    if (s.recent.length > 60) s.recent.length = 60;
    updateBadge(tabId);
    broadcast(tabId, { type: 'event', ev, stats: summary(tabId), top: topHosts(tabId, 4) });
    scheduleSave();
    scheduleTotals();
}

// Non-blocking events: fingerprinting attempts, unwrapped links, AMP skips, sponsor skips, phishing warnings, ...
export function event(tabId, kind, detail = '') {
    const s = tabId >= 0 ? getTab(tabId) : null;
    if (kind === 'replay-alert') {
        kind = 'replay';            // already counted in record()
    } else if (kind === 'fp') {
        pendingTotals.fp++;
        if (s && !s.fpApis.includes(detail)) { s.fpApis.push(detail); s.fp++; }
    } else if (kind === 'dark') {
        if (s && (s.darkKinds ||= []).includes(detail)) return;
        pendingTotals.dark++;
        if (s) { s.darkKinds.push(detail); s.dark = (s.darkKinds.length); }
    } else if (kind in pendingTotals) {
        pendingTotals[kind]++;
        if (s && kind in s) s[kind]++;
    }
    if (s) {
        const ev = { kind, host: detail || s.host, t: Date.now() };
        s.recent.unshift(ev);
        if (s.recent.length > 60) s.recent.length = 60;
        broadcast(tabId, { type: 'event', ev, stats: summary(tabId), top: topHosts(tabId, 4) });
        scheduleSave();
    }
    scheduleTotals();
}

export function summary(tabId) {
    const { recent, hosts, ...rest } = getTab(tabId);
    return rest;
}
export function topHosts(tabId, n) {
    return Object.entries(getTab(tabId).hosts || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
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
    markPaused(tabId);
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
        for (const [id, s] of tabs) obj[id] = { ...s, recent: s.recent.slice(0, 30), hosts: Object.fromEntries(Object.entries(s.hosts || {}).sort((a, b) => b[1] - a[1]).slice(0, 40)) };
        chrome.storage.session.set({ tabStats: obj }).catch(() => {});
    }, 1000);
}
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const addInto = (target, add) => {
    for (const [k, v] of Object.entries(add)) {
        if (k === 'companies') {
            target.companies ||= {};
            for (const [c, n] of Object.entries(v)) target.companies[c] = (target.companies[c] || 0) + n;
        } else target[k] = (target[k] || 0) + v;
    }
    if (target.companies && Object.keys(target.companies).length > 250) {
        target.companies = Object.fromEntries(Object.entries(target.companies).sort((a, b) => b[1] - a[1]).slice(0, 200));
    }
};
function scheduleTotals() {
    if (totalsTimer) return;
    totalsTimer = setTimeout(async () => {
        totalsTimer = 0;
        const add = pendingTotals;
        pendingTotals = ZERO();
        const { totals = { since: Date.now() }, history = {} } = await chrome.storage.local.get(['totals', 'history']);
        addInto(totals, add);
        const today = day();
        history[today] ||= {};
        addInto(history[today], add);
        for (const d of Object.keys(history).sort().slice(0, -60)) delete history[d];   // keep 60 days
        await chrome.storage.local.set({ totals, history });
    }, 4000);
}
export async function totals() {
    const { totals: t = { since: Date.now() } } = await chrome.storage.local.get('totals');
    const out = { blocked: 0, trackers: 0, popups: 0, ...structuredClone(t) };
    addInto(out, pendingTotals);
    return out;
}
export async function history() {
    const { history: h = {} } = await chrome.storage.local.get('history');
    const out = structuredClone(h);
    out[day()] ||= {};
    addInto(out[day()], pendingTotals);
    return out;
}

// ---------------------------------------------------------------------------
// Site grades remembered for the search-result badges (local only)
// ---------------------------------------------------------------------------
let grades = null;
let gradeTimer = 0;
const loadGrades = async () => (grades ||= (await chrome.storage.local.get('siteGrades')).siteGrades || {});
const gradeKey = (host) => String(host || '').replace(/^www\./, '');
function saveGrade(s) {
    // Only pages that were really open a while, with protection on (paused pages see nothing and would look clean)
    if (!s?.host || s.paused || Date.now() - (s.since || 0) < 4000) return;
    const g = grade(s);
    const rec = { letter: g.letter, score: g.score, trackers: s.trackers || 0, companies: g.companies, fp: s.fp || 0, replay: s.replayBy || [], t: Date.now() };
    loadGrades().then((all) => {
        all[gradeKey(s.host)] = rec;
        clearTimeout(gradeTimer);
        gradeTimer = setTimeout(() => {
            const keys = Object.keys(all);
            if (keys.length > 3000) keys.sort((a, b) => all[a].t - all[b].t).slice(0, keys.length - 2500).forEach((k) => delete all[k]);
            chrome.storage.local.set({ siteGrades: all }).catch(() => {});
        }, 2000);
    }).catch(() => {});
}
export async function gradesFor(hosts) {
    const all = await loadGrades();
    const out = {};
    for (const h of hosts) {
        const parts = gradeKey(h).split('.');
        for (let i = 0; i < Math.max(1, parts.length - 1); i++) {
            const g = all[parts.slice(i).join('.')];
            if (g) { out[h] = g; break; }
        }
    }
    return out;
}
export function markPaused(tabId) { getTab(tabId).paused = true; }

export const restored = chrome.storage.session.get('tabStats').then(({ tabStats }) => {
    for (const [id, s] of Object.entries(tabStats || {})) if (!tabs.has(Number(id))) tabs.set(Number(id), s);
}).catch(() => {});
