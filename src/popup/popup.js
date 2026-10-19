const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const forced = Number(new URLSearchParams(location.search).get('tab'));  // used by the test suite
const [tab] = forced ? [{ id: forced }] : await chrome.tabs.query({ active: true, currentWindow: true });
const state = await send({ type: 'popup:state', tabId: tab.id });

const KIND = {
    ad: ['AD', 'var(--accent-2)'], stealth: ['AD', 'var(--accent-2)'], tracker: ['TRK', 'var(--tracker)'],
    threat: ['RISK', 'var(--threat)'], popup: ['POP', 'var(--popup)'], param: ['URL', '#8d8d99']
};
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString());

// ---------------------------------------------------------------------------
// Animated numbers
// ---------------------------------------------------------------------------
const shown = new Map();
function animate(el, to, { bump = false, duration = 900 } = {}) {
    const from = shown.get(el) ?? 0;
    shown.set(el, to);
    if (bump) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
    if (reduced || from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const step = (t) => {
        const p = Math.min(1, (t - t0) / duration);
        const e = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt(Math.round(from + (to - from) * e));
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
// Radar blips
// ---------------------------------------------------------------------------
const blips = $('blips');
const radar = document.querySelector('.radar');
let hitTimer = 0;
function blip(kind) {
    if (reduced) return;
    const angle = Math.random() * Math.PI * 2;
    const r = 0.36 + Math.random() * 0.12;           // between the core and the edge
    const el = document.createElement('i');
    el.className = 'blip';
    el.style.left = `${50 + Math.cos(angle) * r * 100}%`;
    el.style.top = `${50 + Math.sin(angle) * r * 100}%`;
    el.style.setProperty('--c', (KIND[kind] || KIND.ad)[1]);
    blips.append(el);
    setTimeout(() => el.remove(), 2500);
    radar.classList.add('hit');
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => radar.classList.remove('hit'), 280);
}

// ---------------------------------------------------------------------------
// Live feed
// ---------------------------------------------------------------------------
const feed = $('feed');
const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};
function feedItem(ev, animateIn = true) {
    feed.querySelector('.empty')?.remove();
    const li = document.createElement('li');
    if (!animateIn) li.style.animation = 'none';
    const [label] = KIND[ev.kind] || KIND.ad;
    li.innerHTML = '<span class="tag"></span><span class="fhost"></span><span class="ftime"></span>';
    li.querySelector('.tag').textContent = label;
    li.querySelector('.tag').classList.add(ev.kind);
    li.querySelector('.fhost').textContent = ev.host;
    li.querySelector('.ftime').textContent = ago(ev.t);
    li.querySelector('.ftime').dataset.t = ev.t;
    feed.prepend(li);
    while (feed.children.length > 8) feed.lastElementChild.remove();
}
setInterval(() => feed.querySelectorAll('.ftime').forEach((el) => { el.textContent = ago(Number(el.dataset.t)); }), 1000);

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function renderStats(s, hidden, opts = {}) {
    animate($('count'), s.blocked, opts);
    animate($('s-ads'), s.ads);
    animate($('s-trackers'), s.trackers);
    animate($('s-popups'), s.popups);
    if (hidden != null) animate($('s-hidden'), hidden);
    $('params').textContent = s.params ? `${s.params} link tracker${s.params === 1 ? '' : 's'} stripped` : '';
}

function renderSite() {
    const web = state.web;
    $('host').textContent = web ? state.host.replace(/^www\./, '') : 'This page can’t be scanned';
    $('power').checked = !state.disabled;
    $('site-title').textContent = state.disabled ? 'Protection paused' : 'Protection on';
    $('site-sub').textContent = state.disabled ? 'Everything is allowed on this site' : 'Blocking ads & trackers on this site';
    $('status-text').textContent = !web ? 'Idle' : state.disabled ? 'Paused' : 'Live';
    document.body.classList.toggle('paused', state.disabled);
    document.body.classList.toggle('na', !web);
    const t = state.totals;
    $('footer').textContent = `${fmt(t.blocked)} blocked all-time · ${state.lists} lists · ${fmt(state.rules)} filters`;
}

renderSite();
for (const ev of [...state.recent].reverse().slice(-8)) feedItem(ev, false);
// Intro: the radar spins up while the numbers count in
if (!reduced && state.web && !state.disabled) {
    radar.classList.add('fast');
    setTimeout(() => radar.classList.remove('fast'), 1100);
    state.recent.slice(0, 6).forEach((ev, i) => setTimeout(() => blip(ev.kind), 120 + i * 140));
}
renderStats(state.stats, state.hidden, { duration: 1100 });

// Live updates while the popup is open
const port = chrome.runtime.connect({ name: 'live' });
port.postMessage({ type: 'watch', tabId: tab.id });
port.onMessage.addListener((m) => {
    if (m.type === 'event') {
        feedItem(m.ev);
        blip(m.ev.kind);
        renderStats(m.stats, null, { bump: m.ev.kind !== 'param', duration: 400 });
        flash({ tracker: 'tracker', popup: 'popup' }[m.ev.kind] || 'ad');
    } else if (m.type === 'reset') {
        feed.innerHTML = '<li class="empty">Watching this page for ads and trackers…</li>';
        renderStats(m.stats, 0, { duration: 300 });
    }
});
// Hidden-element count changes as the page builds: refresh it now and then
setInterval(async () => {
    const s = await send({ type: 'popup:state', tabId: tab.id });
    if (s?.hidden != null && s.hidden !== shown.get($('s-hidden'))) { animate($('s-hidden'), s.hidden); flash('hidden'); }
}, 2500);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
$('power').addEventListener('change', async (e) => {
    state.disabled = !e.target.checked;
    renderSite();
    await send({ type: 'site:toggle', host: state.host, disabled: state.disabled });
    chrome.tabs.reload(tab.id);
    setTimeout(() => window.close(), 350);
});
$('pick').addEventListener('click', async () => {
    await send({ type: 'picker:start', tabId: tab.id });
    window.close();
});
$('settings').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
