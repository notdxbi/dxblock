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

// Main switch
const renderMaster = (on) => {
    $('master').checked = on;
    document.body.classList.toggle('off', !on);
    $('master-name').textContent = on ? 'dx.block is on' : 'dx.block is off';
    $('master-meta').textContent = on ? 'Blocking ads, trackers and pop-ups everywhere except your allowed sites.' : 'Nothing is blocked anywhere. Switch it back on when you\'re ready.';
};
renderMaster(data.on !== false);
$('master').addEventListener('change', async (e) => {
    renderMaster(e.target.checked);
    await send({ type: 'global:toggle', enabled: e.target.checked });
});

// Allowed sites: add / remove one at a time (the textarea under "Paste a list instead" still works)
function renderChips(sites) {
    const box = $('site-chips');
    box.innerHTML = '';
    if (!sites.length) { const li = document.createElement('li'); li.className = 'none'; li.textContent = 'No allowed sites: dx.block blocks everywhere.'; box.append(li); }
    for (const site of sites) {
        const li = document.createElement('li');
        const name = document.createElement('span'); name.textContent = site;
        const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = `Block on ${site} again`; x.setAttribute('aria-label', x.title);
        x.addEventListener('click', async () => { const clean = await send({ type: 'sites:remove', host: site }); renderChips(clean); $('sites-list').value = clean.join('\n'); });
        li.append(name, x);
        box.append(li);
    }
}
renderChips(data.disabledSites);
$('site-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('site-input').value.trim();
    if (!v) return;
    const clean = await send({ type: 'sites:add', host: v });
    $('site-input').value = '';
    renderChips(clean);
    $('sites-list').value = clean.join('\n');
});
$('sites-list').value = data.disabledSites.join('\n');
$('save-sites').addEventListener('click', async () => {
    const clean = await send({ type: 'options:set-sites', sites: $('sites-list').value.split('\n') });
    $('sites-list').value = clean.join('\n');
    renderChips(clean);
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

// ---------------------------------------------------------------------------
// Data breaches
// ---------------------------------------------------------------------------
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const big = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} billion` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} million` : (n || 0).toLocaleString());
let breachList = null;
const breachesReady = send({ type: 'breach:list' }).then((d) => {
    breachList = d?.list || [];
    const latest = d?.t ? new Date(d.t).toLocaleDateString() : 'never';
    $('bs-meta').textContent = `${breachList.length.toLocaleString()} known breaches (list updated ${latest}). Showing the most recent:`;
    renderSiteSearch('');
    return breachList;
}).catch(() => { breachList = []; $('bs-meta').textContent = 'Couldn’t load the breach list. Check your connection.'; return []; });

function breachCard(b, { isNew = false } = {}) {
    const d = document.createElement('div');
    d.className = 'br-card';
    const classes = (b.classes || []).map((c) => `<i class="${/password|credit|bank|security q|auth|social security|passport/i.test(c) ? 'hot' : ''}">${esc(c)}</i>`).join('');
    d.innerHTML = `<div class="br-head"><b>${esc(b.title || b.name)}</b>${isNew ? '<em class="new">New</em>' : ''}${b.spam ? '<em>Spam list</em>' : ''}<span>${esc((b.date || '').slice(0, 7))}${b.count ? ` · ${big(b.count)} accounts` : ''}${b.domain ? ` · ${esc(b.domain)}` : ''}</span></div>
        ${classes ? `<div class="br-classes">${classes}</div>` : ''}${b.desc ? `<p>${esc(b.desc)}</p>` : b.unknown ? '<p>No details published for this breach yet.</p>' : ''}`;
    d.querySelector('p')?.addEventListener('click', (e) => e.currentTarget.classList.toggle('open'));
    return d;
}

async function lookupEmail(email) {
    const r = await fetch(`https://api.xposedornot.com/v1/check-email/${encodeURIComponent(email)}`, { cache: 'no-store' });
    if (r.status === 404) return [];
    if (r.status === 429) throw new Error('Too many checks in a row. Wait a minute and try again.');
    if (!r.ok) throw new Error(`The breach service didn’t answer (HTTP ${r.status}). Try again later.`);
    const j = await r.json();
    if (j?.Error) return [];
    return [...new Set((j?.breaches || []).flat().map(String))];
}
// XposedOrNot's own list fills in breaches Have I Been Pwned doesn't have (downloaded whole, kept a week)
async function xonList() {
    const { xonBreaches: c } = await chrome.storage.local.get('xonBreaches');
    if (c?.list && Date.now() - c.t < 7 * 24 * 3600e3) return c.list;
    try {
        const r = await fetch('https://api.xposedornot.com/v1/breaches', { cache: 'no-store' });
        const list = ((await r.json())?.exposedBreaches || []).map((b) => ({
            name: String(b.breachID), title: String(b.breachID), domain: String(b.domain || '').toLowerCase(), date: String(b.breachedDate || '').slice(0, 10),
            count: Number(b.exposedRecords) || 0, classes: b.exposedData || [], verified: !!b.verified, desc: String(b.exposureDescription || '').slice(0, 1500)
        }));
        await chrome.storage.local.set({ xonBreaches: { t: Date.now(), list } });
        return list;
    } catch { return c?.list || []; }
}
const key = (n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, '');
async function detailsFor(names) {
    const hibp = new Map((breachList || []).map((b) => [key(b.name), b]));
    let xon = null;
    if (names.some((n) => !hibp.has(key(n)))) xon = new Map((await xonList()).map((b) => [key(b.name), b]));
    return names.map((n) => hibp.get(key(n)) || xon?.get(key(n)) || { name: n, title: n, unknown: true })
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
async function savedEmails() { return (await chrome.storage.local.get('breachWatch')).breachWatch || []; }
async function saveEmail(email, names) {
    const list = (await savedEmails()).filter((x) => x.email !== email);
    list.unshift({ email, names, checked: Date.now() });
    await chrome.storage.local.set({ breachWatch: list.slice(0, 20) });
}

async function showEmailResult(email, names, prev) {
    const box = $('br-results');
    box.innerHTML = '';
    const items = await detailsFor(names);
    const st = $('br-status');
    if (!items.length) {
        st.className = 'br-status good';
        st.innerHTML = `<b>Good news: ${esc(email)} isn’t in any known breach.</b><span>Breaches are found all the time, so check again now and then.</span>`;
        return;
    }
    const pw = items.some((b) => (b.classes || []).some((c) => /password/i.test(c)));
    const fresh = prev ? items.filter((b) => !prev.includes(b.name)) : [];
    st.className = 'br-status bad';
    st.innerHTML = `<b>${esc(email)} was in ${items.length} data breach${items.length === 1 ? '' : 'es'}${fresh.length ? ` (${fresh.length} new since your last check)` : ''}.</b>
        <span>${pw ? 'Passwords were leaked in some of these. Change the password on those sites <u>and anywhere you used the same one</u>, and turn on two-factor login where you can.' : 'No passwords in these leaks, but expect more spam and phishing emails to this address.'}
        Second opinion: <a href="https://haveibeenpwned.com/account/${encodeURIComponent(email)}" target="_blank" rel="noopener">Have I Been Pwned</a>.</span>`;
    const show = (list) => list.forEach((b) => box.append(breachCard(b, { isNew: fresh.includes(b) })));
    // New ones first, then the rest by date; long lists are cut to 12 with a "show all"
    const ordered = [...fresh, ...items.filter((b) => !fresh.includes(b))];
    show(ordered.slice(0, 12));
    if (ordered.length > 12) {
        const more = Object.assign(document.createElement('button'), { textContent: `Show all ${ordered.length} breaches`, className: 'br-more' });
        more.addEventListener('click', () => { more.remove(); show(ordered.slice(12)); });
        box.append(more);
    }
}

async function checkEmail(email, { remember }) {
    const st = $('br-status');
    st.className = 'br-status'; st.textContent = 'Checking…';
    $('br-results').innerHTML = '';
    try {
        await breachesReady;
        const prev = (await savedEmails()).find((x) => x.email === email)?.names;
        const names = await lookupEmail(email);
        await showEmailResult(email, names, prev);
        if (remember) { await saveEmail(email, names); renderSaved(); }
        return names;
    } catch (e) {
        st.className = 'br-status bad'; st.innerHTML = `<b>Couldn’t check right now.</b><span>${esc(e.message)}</span>`;
        return null;
    }
}
$('br-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = $('br-email').value.trim().toLowerCase();
    if (email) checkEmail(email, { remember: $('br-remember').checked });
});

async function renderSaved() {
    const list = await savedEmails();
    $('br-saved-wrap').hidden = !list.length;
    const ul = $('br-saved');
    ul.innerHTML = '';
    for (const x of list) {
        const li = document.createElement('li');
        li.innerHTML = `<button class="link" title="Show results"></button><span class="${x.names.length ? 'bad' : 'ok'}"></span><small class="muted"></small><button class="x" title="Forget this address" aria-label="Forget this address">×</button>`;
        li.querySelector('.link').textContent = x.email;
        li.querySelector('span').textContent = x.names.length ? `${x.names.length} breach${x.names.length === 1 ? '' : 'es'}` : 'not found';
        li.querySelector('small').textContent = `checked ${new Date(x.checked).toLocaleDateString()}`;
        li.querySelector('.link').addEventListener('click', async () => { await breachesReady; $('br-email').value = x.email; showEmailResult(x.email, x.names, null); });
        li.querySelector('.x').addEventListener('click', async () => {
            await chrome.storage.local.set({ breachWatch: (await savedEmails()).filter((y) => y.email !== x.email) });
            renderSaved();
        });
        ul.append(li);
    }
}
renderSaved();
$('br-all').addEventListener('click', async () => {
    const list = await savedEmails();
    let newOnes = 0;
    for (const [i, x] of list.entries()) {
        $('br-all-status').textContent = `Checking ${i + 1} of ${list.length}…`;
        const names = await checkEmail(x.email, { remember: true });
        if (names) newOnes += names.filter((n) => !x.names.includes(n)).length;
        if (i < list.length - 1) await new Promise((r) => setTimeout(r, 1500));   // the service allows about one check a second
    }
    $('br-all-status').textContent = newOnes ? `${newOnes} new breach${newOnes === 1 ? '' : 'es'} found` : 'No new breaches';
});

// Password check (k-anonymity: only the first 5 hex characters of the SHA-1 hash are sent)
$('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('pw').value;
    const st = $('pw-status');
    if (!pw) return;
    st.className = 'br-status'; st.textContent = 'Checking…';
    try {
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(pw)))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        const r = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, { headers: { 'Add-Padding': 'true' }, cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const line = (await r.text()).split('\n').find((l) => l.startsWith(hash.slice(5)));
        const n = line ? Number(line.split(':')[1]) : 0;
        $('pw').value = '';
        if (n > 0) {
            st.className = 'br-status bad';
            st.innerHTML = `<b>This password has leaked ${n.toLocaleString()} time${n === 1 ? '' : 's'}.</b><span>Attackers try leaked passwords first. Stop using it everywhere, and use a password manager to make unique ones.</span>`;
        } else {
            st.className = 'br-status good';
            st.innerHTML = '<b>Not found in any known leak.</b><span>That’s good, but only use it on one site, and make sure it’s long.</span>';
        }
    } catch (err) {
        st.className = 'br-status bad'; st.innerHTML = `<b>Couldn’t check right now.</b><span>${esc(err.message)}</span>`;
    }
});

// Website lookup in the local list
function renderSiteSearch(q) {
    const box = $('bs-results');
    box.innerHTML = '';
    if (!breachList) return;
    q = q.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    const hits = q
        ? breachList.filter((b) => b.domain.includes(q) || b.name.toLowerCase().includes(q) || b.title.toLowerCase().includes(q))
        : [...breachList];
    hits.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (q) $('bs-meta').textContent = hits.length ? `${hits.length} breach${hits.length === 1 ? '' : 'es'} match “${q}”` : `No known breaches match “${q}”.`;
    for (const b of hits.slice(0, q ? 15 : 6)) box.append(breachCard(b));
}
let bsTimer = 0;
$('bs').addEventListener('input', () => { clearTimeout(bsTimer); bsTimer = setTimeout(() => renderSiteSearch($('bs').value), 150); });
$('bs-form').addEventListener('submit', (e) => { e.preventDefault(); renderSiteSearch($('bs').value); });
