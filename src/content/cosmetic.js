// dx.block generic cosmetic filtering.
// Per-site hiding is done by the generated scripts in /cosmetic (registered for their sites only).
// This script handles the generic part lazily, like uBlock Origin: it collects the class and id
// names present in the page and asks the service worker for the matching hiding rules, so pages
// never have to parse tens of thousands of selectors.
(() => {
    if (window.__dxbCosmetic) return;
    window.__dxbCosmetic = true;

    const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
    const seen = new Set();
    let queue = new Set();
    let timer = 0;
    let observer = null;
    let active = true;

    window.__dxbApplied = [];    // read by the popup's "elements hidden" counter
    const addCSS = (css) => {
        if (!css || !active) return;
        for (const line of css.split('\n')) if (line.endsWith('{display:none!important}')) window.__dxbApplied.push(line.slice(0, -24));
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(css);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        } catch {
            const style = document.createElement('style');
            style.textContent = css;
            (document.head || document.documentElement).appendChild(style);
        }
    };

    const collect = (el) => {
        if (el.id && typeof el.id === 'string') {
            const t = `#${el.id}`;
            if (!seen.has(t)) { seen.add(t); queue.add(t); }
        }
        const cl = el.classList;
        if (cl) {
            for (let i = 0; i < cl.length; i++) {
                const t = `.${cl[i]}`;
                if (!seen.has(t)) { seen.add(t); queue.add(t); }
            }
        }
    };

    const scan = (root) => {
        if (root.nodeType !== 1) return;
        collect(root);
        if (root.firstElementChild) for (const el of root.querySelectorAll('[id],[class]')) collect(el);
    };

    const flush = async () => {
        timer = 0;
        if (!queue.size) return;
        const tokens = [...queue];
        queue = new Set();
        addCSS(await send({ type: 'cosmetic:tokens', url: location.href, tokens }));
    };
    const schedule = (delay) => {
        if (!timer) timer = setTimeout(flush, delay);
    };

    const start = () => {
        if (document.documentElement) scan(document.documentElement);
        schedule(0);
        observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type === 'attributes') collect(m.target);
                else for (const n of m.addedNodes) scan(n);
            }
            if (queue.size) schedule(document.readyState === 'loading' ? 30 : 100);
        });
        observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] });
    };

    send({ type: 'cosmetic:init', url: location.href }).then((r) => {
        if (!r || r.off) { active = false; return; }
        addCSS(r.css);
        if (r.generic) start();
    });
})();
