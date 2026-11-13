// dx.block search badges: puts a small privacy grade (A–F) next to search results for sites you've visited
// before (from what dx.block saw them try last time), and a warning chip for sites that leaked user data.
// Nothing leaves your computer: the grades and the breach list are stored by dx.block locally.
(() => {
    if (window.__dxbSearch || window.top !== window) return;
    window.__dxbSearch = true;
    const COLORS = { A: '#22d38a', B: '#9bd34a', C: '#ffb020', D: '#ff7a33', F: '#ff3b45' };
    const h = location.hostname;
    const SEL =
        /(^|\.)google\./.test(h) ? '#search a:has(> h3), #rso a:has(h3)' :
        /(^|\.)bing\.com$/.test(h) ? '#b_results li.b_algo h2 a' :
        /(^|\.)duckduckgo\.com$/.test(h) ? 'a[data-testid="result-title-a"], .result__a' :
        /(^|\.)search\.brave\.com$/.test(h) ? '#results .snippet a.heading-serpresult, #results .snippet[data-type="web"] a:has(.title), #results a.result-header' :
        /(^|\.)startpage\.com$/.test(h) ? 'a.result-title, a.w-gl__result-title' :
        /(^|\.)ecosia\.org$/.test(h) ? 'a.result__link, [data-test-id="result-link"]' : null;
    if (!SEL) return;

    const hostOf = (href) => { try { return new URL(href).hostname.replace(/^www\./, ''); } catch { return ''; } };
    const done = new WeakSet();
    const cache = new Map();
    const esc = (x) => String(x).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

    function badge(info) {
        const wrap = document.createElement('dxblock-badge');
        wrap.style.cssText = 'all:initial;display:inline-flex;gap:4px;margin-left:6px;vertical-align:middle;';
        const root = wrap.attachShadow({ mode: 'closed' });
        const parts = [];
        if (info.grade) parts.push(`<span class="g" style="--c:${COLORS[info.grade.letter] || '#888'}" title="dx.block privacy grade from your last visit (${new Date(info.grade.t).toLocaleDateString()}): ${info.grade.trackers} trackers, ${info.grade.companies} companies, ${info.grade.fp} fingerprinting attempts">${esc(info.grade.letter)}</span>`);
        if (info.breach) parts.push(`<span class="b" title="${esc(info.breach.title)} data breach (${esc(info.breach.date.slice(0, 4))}): ${fmt(info.breach.count)} accounts. Leaked: ${esc(info.breach.classes.slice(0, 6).join(', '))}">breach ${esc(info.breach.date.slice(0, 4))}</span>`);
        root.innerHTML = `<style>
            span{font:700 11px/1 system-ui,sans-serif;border-radius:5px;padding:3px 5px;display:inline-block;cursor:help}
            .g{background:var(--c);color:#08080a;min-width:9px;text-align:center}
            .b{background:rgba(255,59,69,.14);color:#ff5a63;border:1px solid rgba(255,59,69,.4);font-weight:650;text-transform:uppercase;letter-spacing:.03em;font-size:9.5px}</style>${parts.join('')}`;
        return wrap;
    }

    async function run() {
        const links = [...document.querySelectorAll(SEL)].filter((a) => !done.has(a) && a.href && !/^(javascript|data):/.test(a.href));
        if (!links.length) return;
        links.forEach((a) => done.add(a));
        const hosts = [...new Set(links.map((a) => hostOf(a.href)).filter((x) => x && !cache.has(x)))];
        if (hosts.length) {
            const res = await chrome.runtime.sendMessage({ type: 'grades:get', hosts }).catch(() => null);
            for (const x of hosts) cache.set(x, res?.[x] || null);
        }
        for (const a of links) {
            const info = cache.get(hostOf(a.href));
            if (!info || (!info.grade && !info.breach)) continue;
            const title = a.querySelector('h3, h2, .title') || a;
            (title === a ? a : title).appendChild(badge(info));
        }
    }

    chrome.runtime.sendMessage({ type: 'guard:init' }).then((cfg) => {
        if (!cfg || cfg.off) return;
        let t = 0;
        const go = () => { clearTimeout(t); t = setTimeout(run, 300); };
        go();
        new MutationObserver(go).observe(document.documentElement, { childList: true, subtree: true });
    }).catch(() => null);
})();
