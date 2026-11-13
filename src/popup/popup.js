import { TrackerWeb, LiveChart, grade, GRADE_COLORS } from '../ui/graph.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const forced = Number(new URLSearchParams(location.search).get('tab'));  // used by the test suite
const [tab] = forced ? [{ id: forced }] : await chrome.tabs.query({ active: true, currentWindow: true });

const KIND = {
    ad: 'AD', stealth: 'AD', tracker: 'TRK', threat: 'RISK', popup: 'POP', param: 'URL',
    fp: 'FP', phishing: 'WARN', unwrapped: 'LINK', amp: 'AMP', sponsor: 'SKIP', cleaned: 'WIPE',
    replay: 'REC', dark: 'TRICK', consent: 'NOPE', clipboard: 'CLIP'
};
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : (n || 0).toLocaleString());

const web = new TrackerWeb($('web'), { reduced, maxNodes: 30 });
const chart = new LiveChart($('chart'));
setInterval(() => { $('rate').textContent = chart.rate().toFixed(1); }, 1000);

// ---------------------------------------------------------------------------
// Animated numbers
// ---------------------------------------------------------------------------
const shown = new Map();
function animate(el, to, { bump = false, duration = 900 } = {}) {
    to = to || 0;
    const from = shown.get(el) ?? 0;
    shown.set(el, to);
    if (bump && to !== from) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
    if (reduced || from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const step = (t) => {
        const p = Math.min(1, (t - t0) / duration);
        el.textContent = fmt(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}
function flash(cls) {
    const el = document.querySelector(`.stat.${cls}`);
    if (!el) return;
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

// ---------------------------------------------------------------------------
// Live feed / companies / this site
// ---------------------------------------------------------------------------
const live = $('live');
const seen = new Set();
const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};
function feedItem(ev, animateIn = true) {
    const key = `${ev.t}|${ev.host}|${ev.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    live.querySelector('.empty')?.remove();
    const li = document.createElement('li');
    if (!animateIn) li.style.animation = 'none';
    li.innerHTML = '<span class="tag"></span><span class="fhost"></span><span class="fco"></span><span class="ftime"></span>';
    const tag = li.querySelector('.tag');
    tag.textContent = KIND[ev.kind] || 'AD';
    tag.classList.add(ev.kind);
    li.querySelector('.fhost').textContent = ev.kind === 'fp' ? `${ev.host} fingerprinting` : ev.kind === 'replay' ? `${ev.host} tried to record you` : ev.kind === 'consent' ? `cookies rejected on ${ev.host}` : ev.host;
    li.querySelector('.fco').textContent = ev.company || '';
    const time = li.querySelector('.ftime');
    time.textContent = ago(ev.t);
    time.dataset.t = ev.t;
    live.prepend(li);
    while (live.children.length > 9) live.lastElementChild.remove();
    return true;
}
setInterval(() => live.querySelectorAll('.ftime').forEach((el) => { el.textContent = ago(Number(el.dataset.t)); }), 1000);

function renderCompanies(stats) {
    const list = Object.entries(stats?.companies || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const el = $('companies');
    if (!list.length) { el.innerHTML = '<li class="empty">No tracking companies seen yet</li>'; return; }
    const max = list[0][1];
    el.innerHTML = '';
    for (const [name, n] of list) {
        const li = document.createElement('li');
        li.innerHTML = '<div class="bar"><i></i><span></span></div><b></b>';
        li.querySelector('span').textContent = name;
        li.querySelector('b').textContent = n;
        el.append(li);
        requestAnimationFrame(() => { li.querySelector('i').style.width = `${Math.max(10, (n / max) * 100)}%`; });
    }
}

let state = null;
function renderGrade(s) {
    const https = !/^http:/.test(state?.url || '');
    const g = grade(s, https);
    $('grade-l').textContent = g.letter;
    $('grade').style.setProperty('--g', GRADE_COLORS[g.letter]);
    const parts = [];
    if (s.trackers) parts.push(`${s.trackers} tracker${s.trackers === 1 ? '' : 's'}`);
    if (g.companies) parts.push(`${g.companies} compan${g.companies === 1 ? 'y' : 'ies'}`);
    if (s.ads) parts.push(`${s.ads} ad request${s.ads === 1 ? '' : 's'}`);
    if (s.fp) parts.push(`${s.fp} fingerprinting attempt${s.fp === 1 ? '' : 's'}`);
    if (s.popups) parts.push(`${s.popups} pop-up${s.popups === 1 ? '' : 's'}`);
    $('site-summary').innerHTML = '';
    const b = document.createElement('b');
    b.textContent = `Privacy grade ${g.letter}. `;
    $('site-summary').append(b, parts.length ? `This site tried to load ${parts.join(', ')}. All of it was stopped.` : 'Nothing has tried to track you here yet.');
}

function renderStats(s, opts = {}) {
    if (!s) return;
    animate($('count'), s.blocked, opts);
    animate($('s-ads'), s.ads);
    animate($('s-trackers'), s.trackers);
    animate($('s-companies'), Object.keys(s.companies || {}).length);
    animate($('s-fp'), s.fp);
    renderGrade(s);
    renderCompanies(s);
    renderAlerts(s);
}

// Alerts in the "This site" tab: screen recording, data breaches, dark patterns, cookie banners, clipboard
let alertKey = '';
function renderAlerts(s) {
    if (!state) return;
    const items = [];
    if (s.replayBy?.length) items.push(['rec', 'Screen recording blocked', `${s.replayBy.join(', ')} tried to record your mouse, clicks and typing on this site.`]);
    for (const b of state.breaches || []) {
        items.push(['breach', `${b.title} data breach (${b.date.slice(0, 4)})`, `${fmt(b.count)} accounts leaked: ${b.classes.slice(0, 5).join(', ').toLowerCase()}. If you have an account, change its password.`]);
    }
    if (s.darkKinds?.length) items.push(['dark', `${s.darkKinds.length} manipulation trick${s.darkKinds.length === 1 ? '' : 's'} spotted`, `${s.darkKinds.join(' · ')}. They're outlined in orange on the page.`]);
    if (s.consent) items.push(['ok', 'Cookie banner answered "Reject all"', 'dx.block said no to tracking cookies for you.']);
    if (s.clipboard) items.push(['ok', 'Clipboard protected', 'This site tried to change what you copied, or copying was unlocked.']);
    const key = JSON.stringify(items);
    $('alert-dot').hidden = !items.some(([k]) => k === 'rec' || k === 'breach' || k === 'dark');
    if (key === alertKey) return;
    alertKey = key;
    const box = $('alerts');
    box.innerHTML = '';
    for (const [kind, title, text] of items) {
        const d = document.createElement('div');
        d.className = `alert ${kind}`;
        d.innerHTML = '<b></b><span></span>';
        d.querySelector('b').textContent = title;
        d.querySelector('span').textContent = text;
        box.append(d);
    }
}

function renderAllowed() {
    const sites = state.allowedSites || [];
    $('allowed-count').textContent = sites.length ? `${sites.length} site${sites.length === 1 ? '' : 's'}` : '';
    const list = $('allowed-list');
    list.innerHTML = '';
    if (!sites.length) { const li = document.createElement('li'); li.className = 'none'; li.textContent = 'None yet: dx.block blocks everywhere'; list.append(li); return; }
    for (const site of sites) {
        const li = document.createElement('li');
        if (state.host && (state.host === site || state.host.endsWith(`.${site}`))) li.className = 'here';
        const name = document.createElement('span'); name.textContent = site;
        const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = `Block on ${site} again`; x.setAttribute('aria-label', x.title);
        x.addEventListener('click', async () => {
            state.allowedSites = await send({ type: 'sites:remove', host: site });
            state.disabled = state.allowedSites.some((s) => state.host === s || state.host.endsWith(`.${s}`));
            renderSite(); renderAllowed();
        });
        li.append(name, x);
        list.append(li);
    }
}

function renderSite() {
    const onWeb = state.web;
    const on = state.enabled !== false;
    document.body.classList.toggle('off', !on);
    $('global').setAttribute('aria-pressed', String(on));
    $('global').title = on ? 'Turn dx.block off everywhere' : 'Turn dx.block back on';
    $('host').textContent = onWeb ? state.host.replace(/^www\./, '') : 'This page can’t be scanned';
    $('power').checked = !state.disabled;
    $('site-title').textContent = state.disabled ? 'Protection paused' : 'Protection on';
    $('site-sub').textContent = state.disabled ? 'Everything is allowed on this site' : 'Blocking ads & trackers on this site';
    $('status-text').textContent = !on ? 'Off' : !onWeb ? 'Idle' : state.disabled ? 'Paused' : 'Live';
    if (!on) { $('power').checked = false; $('site-title').textContent = 'dx.block is off'; $('site-sub').textContent = 'Nothing is blocked anywhere. Press the power button to turn it back on.'; }
    document.body.classList.toggle('paused', state.disabled);
    document.body.classList.toggle('na', !onWeb);
    web.paused = state.disabled || !onWeb || !on;
    $('access').hidden = state.hasAccess !== false;
    $('update').hidden = !state.update;
    if (state.update) { $('update').href = state.update.url; $('update-v').textContent = `v${state.update.version}`; }
    $('lock').classList.toggle('on', !!state.locked);
    $('lock-t').textContent = state.locked ? 'Locked down' : 'Lockdown';
    for (const id of ['lock', 'unlock', 'clean']) $(id).disabled = !onWeb;
    const proxy = state.tweaks?.proxy?.mode !== 'off' ? ' · IP hidden' : '';
    $('footer').textContent = `${fmt(state.totals.blocked)} blocked all-time · ${state.lists} lists · ${fmt(state.rules)} filters${proxy}`;
}

async function refreshHidden() {
    if (!state?.web || state.disabled) return;
    const n = await send({ type: 'popup:hidden', tabId: tab.id });
    if (typeof n === 'number' && n !== shown.get($('s-hidden'))) {
        if (shown.has($('s-hidden'))) flash('hidden');
        animate($('s-hidden'), n);
    }
}

async function loadPerms() {
    if (!state?.web) return;
    const r = await send({ type: 'site:permissions', tabId: tab.id });
    const box = $('perms');
    box.innerHTML = '';
    if (!r?.perms) return;
    const NAMES = { camera: 'Camera', microphone: 'Microphone', geolocation: 'Location', notifications: 'Notifications' };
    for (const [k, v] of Object.entries(r.perms)) {
        const d = document.createElement('div');
        d.className = 'perm';
        d.innerHTML = '<span></span><em></em>';
        d.querySelector('span').textContent = NAMES[k] || k;
        const em = d.querySelector('em');
        em.textContent = v === 'granted' ? 'allowed' : v === 'denied' ? 'blocked' : 'ask';
        if (v === 'granted') {
            em.className = 'granted';
            if (r.canRevoke) {
                const btn = Object.assign(document.createElement('button'), { textContent: 'Revoke' });
                btn.addEventListener('click', async () => {
                    const ok = await chrome.permissions.request({ permissions: ['contentSettings'] }).catch(() => false);
                    if (!ok) return;
                    const res = await send({ type: 'site:revoke', url: state.url, name: k });
                    if (res?.ok) { em.textContent = 'blocked'; em.className = ''; btn.remove(); }
                });
                d.append(btn);
            }
        }
        box.append(d);
    }
}

async function load(first) {
    const s = await send({ type: 'popup:state', tabId: tab.id });
    if (!s || s.error) return;
    const fresh = !state;
    const prevAllowed = state && JSON.stringify(state.allowedSites);
    state = s;
    renderSite();
    if (fresh || prevAllowed !== JSON.stringify(s.allowedSites)) renderAllowed();
    if (fresh) {
        const recent = [...s.recent].reverse();
        for (const ev of recent.slice(-9)) feedItem(ev, false);
        for (const ev of recent) seen.add(`${ev.t}|${ev.host}|${ev.kind}`);
        // Replay the page's blocks into the web so it fills up when the popup opens
        recent.slice(-30).forEach((ev, i) => setTimeout(() => web.add(ev), reduced ? 0 : 60 + i * 55));
        chart.seed(s.recent);
        renderStats(s.stats, { duration: 1100 });
    } else {
        let added = 0;
        for (const ev of [...s.recent].reverse()) if (feedItem(ev)) { added++; web.add(ev); chart.hit(); }
        renderStats(s.stats, { bump: added > 0, duration: 400 });
    }
    if (first) { refreshHidden(); loadPerms(); }
}
await load(true);

// Live updates while the popup is open
try {
    const port = chrome.runtime.connect({ name: 'live' });
    port.postMessage({ type: 'watch', tabId: tab.id });
    port.onMessage.addListener((m) => {
        if (m.type === 'event') {
            if (feedItem(m.ev)) { web.add(m.ev); if (m.ev.kind !== 'param') chart.hit(); }
            renderStats(m.stats, { bump: m.ev.kind !== 'param', duration: 400 });
            flash({ tracker: 'tracker', fp: 'fp' }[m.ev.kind] || 'ad');
        } else if (m.type === 'reset') {
            live.innerHTML = '<li class="empty">Scanning the new page…</li>';
            seen.clear();
            renderStats(m.stats, { duration: 300 });
            shown.set($('s-hidden'), 0); $('s-hidden').textContent = '0';
        }
    });
} catch { /* polling below keeps it current */ }
setInterval(() => load(false), 1500);
setInterval(refreshHidden, 2000);

// Tabs
document.querySelectorAll('.ftab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.ftab').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== b.dataset.view; });
}));

// Main switch
$('global').addEventListener('click', async () => {
    state.enabled = state.enabled === false;
    renderSite();
    await send({ type: 'global:toggle', enabled: state.enabled });
    chrome.tabs.reload(tab.id);
});

// Allowed sites
$('allowed-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('allowed-input').value.trim();
    if (!v) return;
    state.allowedSites = await send({ type: 'sites:add', host: v });
    $('allowed-input').value = '';
    state.disabled = state.allowedSites.some((s) => state.host === s || state.host.endsWith(`.${s}`));
    renderSite(); renderAllowed();
});

// Actions
$('power').addEventListener('change', async (e) => {
    state.disabled = !e.target.checked;
    renderSite();
    await send({ type: 'site:toggle', host: state.host, disabled: state.disabled });
    chrome.tabs.reload(tab.id);
    setTimeout(() => window.close(), 350);
});
$('lock').addEventListener('click', async () => {
    state.locked = !state.locked;
    renderSite();
    await send({ type: 'site:lock', host: state.host, on: state.locked });
    chrome.tabs.reload(tab.id);
});
$('unlock').addEventListener('click', async () => {
    await send({ type: 'site:unlock', tabId: tab.id });
    $('unlock').lastChild.textContent = 'Unlocked';
});
$('clean').addEventListener('click', async () => {
    const url = await send({ type: 'link:clean', url: state.url });
    if (typeof url !== 'string') return;
    try { await navigator.clipboard.writeText(url); $('clean-t').textContent = url === state.url ? 'Copied' : 'Copied clean'; } catch { $('clean-t').textContent = 'Failed'; }
    setTimeout(() => { $('clean-t').textContent = 'Clean link'; }, 1800);
});
$('pick').addEventListener('click', async () => { await send({ type: 'picker:start', tabId: tab.id }); window.close(); });
$('dashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard/dashboard.html?tab=${tab.id}`) });
    window.close();
});
$('report').addEventListener('click', () => {
    const info = state || {};
    const q = new URLSearchParams({
        template: 'problem.yml',
        title: `Problem on ${info.host || 'a site'}`,
        site: info.host || '',
        version: chrome.runtime.getManifest().version,
        browser: navigator.userAgent,
        lists: String(info.lists || '')
    });
    chrome.tabs.create({ url: `https://github.com/notdxbi/dxblock/issues/new?${q}` });
    window.close();
});
$('settings').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
$('grant').addEventListener('click', async () => {
    const ok = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] }).catch(() => false);
    if (ok) { state.hasAccess = true; renderSite(); chrome.tabs.reload(tab.id); }
});
