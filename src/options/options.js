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
