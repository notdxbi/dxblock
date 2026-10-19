const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const forced = Number(new URLSearchParams(location.search).get('tab'));  // used by the test suite
const [tab] = forced ? [{ id: forced }] : await chrome.tabs.query({ active: true, currentWindow: true });

const KIND = {
    ad: ['AD', 'var(--accent-2)'], stealth: ['AD', 'var(--accent-2)'], tracker: ['TRK', 'var(--tracker)'],
    threat: ['RISK', 'var(--threat)'], popup: ['POP', 'var(--popup)'], param: ['URL', '#8d8d99']
};
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : (n || 0).toLocaleString());

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
// Radar
// ---------------------------------------------------------------------------
const blips = $('blips');
const radar = document.querySelector('.radar');
let hitTimer = 0;
function blip(kind) {
    if (reduced) return;
    const angle = Math.random() * Math.PI * 2;
    const r = 0.36 + Math.random() * 0.12;
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
// Feed + top blocked
// ---------------------------------------------------------------------------
const feed = $('feed');
const top = $('top');
const seen = new Set();          // events already in the feed (key: time + host)
const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};
function feedItem(ev, animateIn = true) {
    const key = `${ev.t}|${ev.host}|${ev.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    feed.querySelector('.empty')?.remove();
    const li = document.createElement('li');
    if (!animateIn) li.style.animation = 'none';
    li.innerHTML = '<span class="tag"></span><span class="fhost"></span><span class="ftime"></span>';
    const tag = li.querySelector('.tag');
    tag.textContent = (KIND[ev.kind] || KIND.ad)[0];
    tag.classList.add(ev.kind);
    li.querySelector('.fhost').textContent = ev.host;
    const time = li.querySelector('.ftime');
    time.textContent = ago(ev.t);
    time.dataset.t = ev.t;
    feed.prepend(li);
    while (feed.children.length > 8) feed.lastElementChild.remove();
    return true;
}
setInterval(() => feed.querySelectorAll('.ftime').forEach((el) => { el.textContent = ago(Number(el.dataset.t)); }), 1000);

function renderTop(list) {
    if (!list?.length) { top.innerHTML = '<li class="empty">Nothing blocked yet on this page</li>'; return; }
    const max = list[0][1];
    top.innerHTML = '';
    for (const [host, n] of list) {
        const li = document.createElement('li');
        li.innerHTML = '<div class="bar"><i></i><span></span></div><b></b>';
        li.querySelector('span').textContent = host;
        li.querySelector('b').textContent = n;
        top.append(li);
        requestAnimationFrame(() => { li.querySelector('i').style.width = `${Math.max(8, (n / max) * 100)}%`; });
    }
}
document.querySelectorAll('.ftab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.ftab').forEach((x) => x.classList.toggle('on', x === b));
    feed.hidden = b.dataset.view !== 'live';
    top.hidden = b.dataset.view !== 'top';
}));

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
let state = null;
function renderStats(s, opts = {}) {
    if (!s) return;
    animate($('count'), s.blocked, opts);
    animate($('s-ads'), s.ads);
    animate($('s-trackers'), s.trackers);
    animate($('s-popups'), s.popups);
    $('params').textContent = s.params ? `${s.params} link tracker${s.params === 1 ? '' : 's'} removed` : '';
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
    $('access').hidden = state.hasAccess !== false;
    $('update').hidden = !state.update;
    if (state.update) { $('update').href = state.update.url; $('update-v').textContent = `v${state.update.version}`; }
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

async function load(first) {
    const s = await send({ type: 'popup:state', tabId: tab.id });
    if (!s || s.error) return;
    const fresh = !state;
    state = s;
    renderSite();
    if (fresh) {
        for (const ev of [...s.recent].reverse().slice(-8)) feedItem(ev, false);
        if (!reduced && s.web && !s.disabled) {
            radar.classList.add('fast');
            setTimeout(() => radar.classList.remove('fast'), 1100);
            s.recent.slice(0, 6).forEach((ev, i) => setTimeout(() => blip(ev.kind), 120 + i * 140));
        }
        renderStats(s.stats, { duration: 1100 });
    } else {
        // Fallback when the live port missed something: add new events, update numbers
        let added = 0;
        for (const ev of [...s.recent].reverse()) if (feedItem(ev)) { added++; if (added <= 4) blip(ev.kind); }
        renderStats(s.stats, { bump: added > 0, duration: 400 });
    }
    renderTop(s.top);
    if (first) refreshHidden();
}
await load(true);

// Live updates while the popup is open
try {
    const port = chrome.runtime.connect({ name: 'live' });
    port.postMessage({ type: 'watch', tabId: tab.id });
    port.onMessage.addListener((m) => {
        if (m.type === 'event') {
            if (feedItem(m.ev)) blip(m.ev.kind);
            renderStats(m.stats, { bump: m.ev.kind !== 'param', duration: 400 });
            if (m.top) renderTop(m.top);
            flash({ tracker: 'tracker', popup: 'popup' }[m.ev.kind] || 'ad');
        } else if (m.type === 'reset') {
            feed.innerHTML = '<li class="empty">Scanning the new page…</li>';
            seen.clear();
            renderStats(m.stats, { duration: 300 });
            renderTop([]);
            shown.set($('s-hidden'), 0); $('s-hidden').textContent = '0';
        }
    });
} catch { /* the polling below still keeps it current */ }
setInterval(() => load(false), 1500);
setInterval(refreshHidden, 2000);

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
$('grant').addEventListener('click', async () => {
    const ok = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] }).catch(() => false);
    if (ok) { state.hasAccess = true; renderSite(); chrome.tabs.reload(tab.id); }
});
