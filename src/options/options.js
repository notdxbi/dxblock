const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const CATS = [['ads', 'Ads'], ['privacy', 'Privacy'], ['security', 'Security'], ['annoyances', 'Annoyances']];

// Tabs
function showTab(id) {
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== id; });
    document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.hash === `#${id}`));
}
window.addEventListener('hashchange', () => showTab(location.hash.slice(1) || 'lists'));
showTab(location.hash.slice(1) || 'lists');

const data = await send({ type: 'options:get' });
$('version').textContent = `v${data.version}`;
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString());
function countUp(el, to) {
    const t0 = performance.now();
    const step = (t) => { const p = Math.min(1, (t - t0) / 1200); el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - p, 3)))); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
}
countUp($('t-blocked'), data.totals.blocked);
countUp($('t-trackers'), data.totals.trackers);
countUp($('t-popups'), data.totals.popups);
countUp($('t-filters'), data.lists.filter((l) => data.enabled.includes(l.id)).reduce((n, l) => n + (l.filters || 0), 0));

function renderLists() {
    const on = new Set(data.enabled);
    const box = $('list-groups');
    box.innerHTML = '';
    for (const [cat, title] of CATS) {
        const items = data.lists.filter((l) => l.cat === cat);
        if (!items.length) continue;
        const g = document.createElement('div');
        g.className = 'group';
        g.innerHTML = `<h2>${title}</h2>`;
        for (const l of items) {
            const row = document.createElement('label');
            row.className = 'list';
            row.innerHTML = `
              <div class="info">
                <div class="name"></div>
                <div class="meta"></div>
                <div class="err" hidden></div>
              </div>
              <span class="switch"><input type="checkbox"><span></span></span>`;
            const name = row.querySelector('.name');
            const link = Object.assign(document.createElement('a'), { href: l.home, target: '_blank', rel: 'noopener', textContent: l.name });
            link.addEventListener('click', (e) => e.stopPropagation());
            name.append(link);
            row.querySelector('.meta').textContent = `${l.desc} · ${(l.filters || 0).toLocaleString()} filters${l.cosmetic ? ` · ${l.cosmetic.toLocaleString()} cosmetic` : ''}`;
            const input = row.querySelector('input');
            input.checked = on.has(l.id);
            input.addEventListener('change', async () => {
                const err = row.querySelector('.err');
                err.hidden = true;
                const res = await send({ type: 'options:set-list', id: l.id, on: input.checked });
                if (res?.error) {
                    input.checked = !input.checked;
                    err.textContent = `Couldn't change this list: ${res.error}`;
                    err.hidden = false;
                } else {
                    data.enabled = input.checked ? [...data.enabled, l.id] : data.enabled.filter((x) => x !== l.id);
                    updateCapacity();
                }
            });
            g.append(row);
        }
        box.append(g);
    }
    updateCapacity();
}
async function updateCapacity() {
    const fresh = await send({ type: 'options:get' });
    const used = fresh.lists.filter((l) => fresh.enabled.includes(l.id)).reduce((n, l) => n + (l.rules || 0), 0);
    $('capacity').textContent = `${used.toLocaleString()} network rules active` +
        (fresh.available != null ? ` · room for ${fresh.available.toLocaleString()} more` : '');
}
renderLists();

// My filters
$('user-filters').value = data.userFilters;
$('save-filters').addEventListener('click', async () => {
    const res = await send({ type: 'options:save-filters', text: $('user-filters').value });
    const st = $('filters-status');
    if (res.ruleError) { st.className = 'bad'; st.textContent = `Saved, but Chrome rejected some network rules: ${res.ruleError}`; return; }
    st.className = res.errors.length ? 'bad' : 'ok';
    st.textContent = `${res.ok} filters active` + (res.errors.length ? ` · ${res.errors.length} not supported: ${res.errors.slice(0, 3).join('  ')}` : '');
});

// Allowed sites
$('sites-list').value = data.disabledSites.join('\n');
$('save-sites').addEventListener('click', async () => {
    const clean = await send({ type: 'options:set-sites', sites: $('sites-list').value.split('\n') });
    $('sites-list').value = clean.join('\n');
    $('sites-status').className = 'ok';
    $('sites-status').textContent = `${clean.length} site${clean.length === 1 ? '' : 's'} allowed`;
});

// Privacy & IP
const tw = data.tweaks;
document.querySelectorAll('[data-tweak]').forEach((input) => {
    input.checked = !!tw[input.dataset.tweak];
    input.addEventListener('change', () => send({ type: 'tweaks:set', tweaks: { [input.dataset.tweak]: input.checked } }));
});
const PRESETS = { tor: { scheme: 'socks5', host: '127.0.0.1', port: 9050 }, torbrowser: { scheme: 'socks5', host: '127.0.0.1', port: 9150 } };
const px = tw.proxy;
const fill = (p) => { $('px-scheme').value = p.scheme; $('px-host').value = p.host; $('px-port').value = p.port; };
const markPreset = () => {
    const cur = { scheme: $('px-scheme').value, host: $('px-host').value, port: Number($('px-port').value) };
    const match = Object.entries(PRESETS).find(([, p]) => p.scheme === cur.scheme && p.host === cur.host && p.port === cur.port)?.[0] || 'custom';
    document.querySelectorAll('#px-preset button').forEach((b) => b.classList.toggle('on', b.dataset.p === match));
};
fill(px); $('px-user').value = px.user || ''; $('px-pass').value = px.pass || '';
$('px-on').checked = px.mode !== 'off';
$('px-form').classList.toggle('off', px.mode === 'off');
markPreset();
document.querySelectorAll('#px-preset button').forEach((b) => b.addEventListener('click', () => {
    if (PRESETS[b.dataset.p]) fill(PRESETS[b.dataset.p]); else { $('px-host').focus(); }
    markPreset();
}));
['px-scheme', 'px-host', 'px-port'].forEach((id) => $(id).addEventListener('input', markPreset));
const proxyValue = (on) => ({ mode: on ? 'fixed' : 'off', scheme: $('px-scheme').value, host: $('px-host').value.trim(), port: Number($('px-port').value), user: $('px-user').value, pass: $('px-pass').value });
async function saveProxy(on) {
    const p = proxyValue(on);
    if (on && (!p.host || !(p.port > 0 && p.port < 65536))) { $('ip-status').className = 'bad'; $('ip-status').textContent = 'Enter a server and port first.'; $('px-on').checked = false; return; }
    await send({ type: 'tweaks:set', tweaks: { proxy: p } });
    $('px-form').classList.toggle('off', !on);
    $('ip-status').className = 'ok';
    $('ip-status').textContent = on ? `Proxy on: ${p.scheme}://${p.host}:${p.port}` : 'Direct connection';
}
$('px-on').addEventListener('change', () => saveProxy($('px-on').checked));
$('px-save').addEventListener('click', () => { $('px-on').checked = true; saveProxy(true); });
$('ip-check').addEventListener('click', async () => {
    $('ip-status').className = 'muted';
    $('ip-status').textContent = 'Checking…';
    try {
        const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
        const { ip } = await r.json();
        $('ip-status').className = 'ok';
        $('ip-status').textContent = `Websites see you as ${ip}${$('px-on').checked ? ' (through the proxy)' : ''}`;
    } catch {
        $('ip-status').className = 'bad';
        $('ip-status').textContent = $('px-on').checked ? 'No connection through the proxy: is it running?' : 'Couldn\'t reach the IP check service.';
    }
});

// Diagnostics
async function diagnostics() {
    const d = await send({ type: 'diagnostics' });
    const lines = [
        `dx.block ${d.version}${d.firefox ? ' (Firefox build)' : ''}`,
        `Browser: ${d.browser}`,
        `Site access granted: ${d.hostAccess}`,
        `Filter lists active: ${d.rulesets} (${d.rulesetIds.join(', ')})`,
        `Dynamic rules: ${d.dynamicRules} · session rules: ${d.sessionRules} · room for ${d.staticRuleRoom ?? '?'} more static rules`,
        `Registered page scripts: ${d.contentScripts}`,
        `WebRTC policy: ${d.webrtc ?? 'not available'} · proxy: ${d.proxy ?? 'not available'}`,
        `Allowed sites: ${d.allowedSites} · my filter lines: ${d.userFilterLines}`,
        `Blocked all-time: ${d.totals.blocked} (trackers ${d.totals.trackers}, pop-ups ${d.totals.popups})`,
        '',
        d.errors.length ? 'Recent errors:' : 'No errors recorded.',
        ...d.errors.map((e) => `  ${new Date(e.t).toISOString()}  [${e.where}] ${e.message}`)
    ];
    $('diag-out').textContent = lines.join('\n');
}
$('diag-refresh').addEventListener('click', diagnostics);
$('diag-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('diag-out').textContent);
    $('diag-status').className = 'ok'; $('diag-status').textContent = 'Copied';
});
window.addEventListener('hashchange', () => { if (location.hash === '#diag') diagnostics(); });
if (location.hash === '#diag') diagnostics();

// Updates
$('update-now').addEventListener('click', async () => {
    $('update-status').className = 'muted'; $('update-status').textContent = 'Checking…';
    const u = await send({ type: 'update:check' });
    $('update-status').className = u ? 'ok' : 'muted';
    $('update-status').innerHTML = '';
    if (u) { const a = Object.assign(document.createElement('a'), { href: u.url, target: '_blank', rel: 'noopener', textContent: `Version ${u.version} is available: download` }); $('update-status').append(a); }
    else $('update-status').textContent = `You're up to date (v${data.version}).`;
});

// Forget sites when I leave (needs the optional cookies + browsingData permissions)
$('forget').checked = !!tw.forget;
$('keep').value = (tw.keepSites || []).join('\n');
$('forget').addEventListener('change', async () => {
    const st = $('forget-status');
    if ($('forget').checked) {
        const ok = await chrome.permissions.request({ permissions: ['cookies', 'browsingData'] }).catch(() => false);
        if (!ok) { $('forget').checked = false; st.className = 'bad'; st.textContent = 'Permission needed to delete site data.'; return; }
    }
    await send({ type: 'tweaks:set', tweaks: { forget: $('forget').checked } });
    st.className = 'ok'; st.textContent = $('forget').checked ? 'On: closed sites are forgotten' : 'Off';
});
$('keep-save').addEventListener('click', async () => {
    const keepSites = [...new Set($('keep').value.split('\n').map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')).filter(Boolean))];
    await send({ type: 'tweaks:set', tweaks: { keepSites } });
    $('keep').value = keepSites.join('\n');
    $('forget-status').className = 'ok'; $('forget-status').textContent = `${keepSites.length} site${keepSites.length === 1 ? '' : 's'} kept`;
});
$('forget-now').addEventListener('click', async () => {
    if (!$('forget').checked) { $('forget-status').className = 'bad'; $('forget-status').textContent = 'Switch the feature on first.'; return; }
    await send({ type: 'forget:now' });
    $('forget-status').className = 'ok'; $('forget-status').textContent = 'Closed sites cleaned';
});
send({ type: 'hotfix:info' }).then((h) => {
    if (h?.at) $('hotfix-meta').textContent += ` Last update ${new Date(h.at).toLocaleString()} (${h.rules} fixes).`;
});
