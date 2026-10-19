import { TrackerWeb, LiveChart, grade, GRADE_COLORS } from '../ui/graph.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : (n || 0).toLocaleString());
const KIND = { ad: 'AD', stealth: 'AD', tracker: 'TRK', threat: 'RISK', popup: 'POP', param: 'URL', fp: 'FP', phishing: 'WARN', unwrapped: 'LINK', amp: 'AMP', sponsor: 'SKIP', cleaned: 'WIPE' };

const tabId = Number(new URLSearchParams(location.search).get('tab')) || null;
const web = new TrackerWeb($('web'), { labels: true, maxNodes: 70, reduced });
const chart = new LiveChart($('chart'));
setInterval(() => { $('rate').textContent = `${chart.rate().toFixed(1)}/s`; }, 1000);

// ---------------------------------------------------------------------------
const shown = new Map();
function animate(el, to, duration = 900) {
    to = to || 0;
    const from = shown.get(el) ?? 0;
    shown.set(el, to);
    if (reduced || from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const step = (t) => {
        const p = Math.min(1, (t - t0) / duration);
        el.textContent = fmt(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}
function bars(el, entries, empty) {
    if (!entries.length) { el.innerHTML = `<li class="empty">${empty}</li>`; return; }
    const max = entries[0][1];
    el.innerHTML = '';
    for (const [name, n] of entries) {
        const li = document.createElement('li');
        li.innerHTML = '<div class="bar"><i></i><span></span></div><b></b>';
        li.querySelector('span').textContent = name;
        li.querySelector('b').textContent = fmt(n);
        el.append(li);
        requestAnimationFrame(() => { li.querySelector('i').style.width = `${Math.max(6, (n / max) * 100)}%`; });
    }
}

const feed = $('feed');
const seen = new Set();
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`; };
function feedItem(ev, animateIn = true) {
    const key = `${ev.t}|${ev.host}|${ev.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    feed.querySelector('.empty')?.remove();
    const li = document.createElement('li');
    if (!animateIn) li.style.animation = 'none';
    li.innerHTML = '<span class="tag"></span><span class="h"></span><span class="co"></span><span class="t"></span>';
    const tag = li.querySelector('.tag');
    tag.textContent = KIND[ev.kind] || 'AD';
    tag.classList.add(ev.kind);
    li.querySelector('.h').textContent = ev.kind === 'fp' ? `${ev.host} fingerprinting stopped` : ev.host;
    li.querySelector('.co').textContent = ev.company || '';
    li.querySelector('.t').textContent = ago(ev.t);
    li.querySelector('.t').dataset.t = ev.t;
    feed.prepend(li);
    while (feed.children.length > 24) feed.lastElementChild.remove();
    return true;
}
setInterval(() => feed.querySelectorAll('.t').forEach((el) => { el.textContent = ago(Number(el.dataset.t)); }), 1000);

function renderTab(s, host) {
    if (!s) return;
    const label = !host ? 'No tab selected' : host === chrome.runtime.id ? 'a dx.block page' : host.replace(/^www\./, '');
    $('watching').textContent = `Watching ${label}`;
    animate($('count'), s.blocked);
    animate($('c-ads'), s.ads);
    animate($('c-trackers'), s.trackers);
    animate($('c-companies'), Object.keys(s.companies || {}).length);
    animate($('c-fp'), s.fp);
    animate($('c-popups'), s.popups);
    animate($('c-params'), s.params);
    const g = grade(s);
    $('grade-l').textContent = g.letter;
    $('grade').style.setProperty('--g', GRADE_COLORS[g.letter]);
    $('grade-text').textContent = s.blocked
        ? `${s.trackers} trackers from ${g.companies} companies, ${s.ads} ad requests${s.fp ? ` and ${s.fp} fingerprinting attempts` : ''}. All stopped.`
        : 'Nothing has tried to track you on this page yet.';
    bars($('companies'), Object.entries(s.companies || {}).sort((a, b) => b[1] - a[1]).slice(0, 8), 'No tracking companies seen yet');
}

// Weekly report
function renderWeek(history) {
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
    const sum = { blocked: 0, trackers: 0, fp: 0, companies: {} };
    for (const d of days) {
        const h = history[d] || {};
        sum.blocked += h.blocked || 0; sum.trackers += h.trackers || 0; sum.fp += h.fp || 0;
        for (const [c, n] of Object.entries(h.companies || {})) sum.companies[c] = (sum.companies[c] || 0) + n;
    }
    animate($('w-blocked'), sum.blocked);
    animate($('w-trackers'), sum.trackers);
    animate($('w-fp'), sum.fp);
    // Estimates: ~40 KB and ~25 ms per blocked request (typical ad/tracker script sizes and connection costs)
    $('w-data').textContent = `${(sum.blocked * 40 / 1024).toFixed(sum.blocked * 40 / 1024 < 10 ? 1 : 0)} MB`;
    $('w-time').textContent = `${Math.round((sum.blocked * 0.025) / 60)} min`;
    $('week-range').textContent = `${new Date(days[0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – today`;
    bars($('w-companies'), Object.entries(sum.companies).sort((a, b) => b[1] - a[1]).slice(0, 6), 'Browse a little and your report fills in');
    drawWeek(days.map((d) => history[d] || {}), days);
}
function drawWeek(data, days) {
    const c = $('week');
    const dpr = Math.min(2, devicePixelRatio || 1);
    const { width, height } = c.getBoundingClientRect();
    c.width = width * dpr; c.height = height * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const max = Math.max(10, ...data.map((d) => d.blocked || 0));
    const bw = width / 7;
    data.forEach((d, i) => {
        const total = d.blocked || 0, trk = Math.min(total, d.trackers || 0);
        const hTotal = (total / max) * (height - 8), hTrk = (trk / max) * (height - 8);
        const x = i * bw + bw * 0.22, w = bw * 0.56;
        const g = ctx.createLinearGradient(0, height - hTotal, 0, height);
        g.addColorStop(0, 'rgba(255,59,69,.95)'); g.addColorStop(1, 'rgba(229,9,20,.25)');
        ctx.fillStyle = g;
        const rr = (y, hh) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, hh, 6); else ctx.rect(x, y, w, hh); ctx.fill(); };
        rr(height - hTotal, hTotal);
        ctx.fillStyle = 'rgba(169,112,255,.85)';
        if (hTrk > 0) rr(height - hTrk, hTrk);
    });
    $('days').innerHTML = days.map((d) => `<span>${new Date(d).toLocaleDateString(undefined, { weekday: 'short' })}</span>`).join('');
}

// Protection status
async function renderShields() {
    const o = await send({ type: 'options:get' });
    if (!o) return;
    const t = o.tweaks;
    const items = [
        ['Ad & tracker blocking', true, `${o.enabled.length} lists`],
        ['Pop-up blocking', true, ''],
        ['Anti-fingerprinting', t.fingerprint, ''],
        ['Third-party cookies blocked', t.cookies3p, ''],
        ['Tracking beacons blocked', t.beacons, ''],
        ['Tracking links skipped', t.unwrap, ''],
        ['Fake-site warnings', t.lookalike, ''],
        ['WebRTC IP-leak protection', t.webrtc, ''],
        ['Global Privacy Control', t.gpc, ''],
        ['HTTPS-only', t.httpsOnly, ''],
        ['Hide IP (proxy)', t.proxy?.mode !== 'off', t.proxy?.mode !== 'off' ? `${t.proxy.host}:${t.proxy.port}` : ''],
        ['Forget sites on close', t.forget, ''],
        ['Fast fixes (daily)', t.hotfix, '']
    ];
    $('shields').innerHTML = '';
    for (const [name, on, note] of items) {
        const li = document.createElement('li');
        li.className = on ? 'on' : '';
        li.innerHTML = '<i></i><b></b><span></span>';
        li.querySelector('b').textContent = name;
        li.querySelector('span').textContent = note || (on ? 'on' : 'off');
        $('shields').append(li);
    }
}

// ---------------------------------------------------------------------------
async function load(first) {
    const d = await send({ type: 'dashboard:state', tabId });
    if (!d) return;
    if (first) {
        const recent = [...(d.recent || [])].reverse();
        for (const ev of recent.slice(-24)) feedItem(ev, false);
        for (const ev of recent) seen.add(`${ev.t}|${ev.host}|${ev.kind}`);
        recent.slice(-60).forEach((ev, i) => setTimeout(() => web.add(ev), reduced ? 0 : 80 + i * 45));
        chart.seed(d.recent || []);
    } else {
        for (const ev of [...(d.recent || [])].reverse()) if (feedItem(ev)) { web.add(ev); chart.hit(); }
    }
    renderTab(d.stats, d.host);
    renderWeek(d.history);
}
await load(true);
renderShields();

if (tabId) {
    const port = chrome.runtime.connect({ name: 'live' });
    port.postMessage({ type: 'watch', tabId });
    port.onMessage.addListener((m) => {
        if (m.type === 'event') {
            if (feedItem(m.ev)) { web.add(m.ev); if (m.ev.kind !== 'param') chart.hit(); }
            renderTab(m.stats, $('watching').textContent.replace(/^Watching /, ''));
        } else if (m.type === 'reset') {
            feed.innerHTML = '<li class="empty">The watched tab opened a new page…</li>';
            seen.clear();
            web.nodes.clear(); web.hubs.clear(); web.layout();
            load(false);
        }
    });
}
setInterval(() => load(false), 3000);
setInterval(renderShields, 10_000);
