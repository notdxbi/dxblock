// dx.block page guard (isolated world): forwards fingerprinting reports, warns before passwords are typed on
// insecure pages, sends AMP pages to the original article, and shows the real destination of tracking links.
(() => {
    if (window.__dxbGuard) return;
    window.__dxbGuard = true;
    const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

    // Fingerprinting attempts reported by content/fingerprint.js (page world)
    const fp = new Set();
    document.addEventListener('dxb-fp', (e) => {
        const api = String(e.detail || '').slice(0, 20);
        if (!api || fp.has(api)) return;
        fp.add(api);
        send({ type: 'guard:fp', api });
    });

    send({ type: 'guard:init' }).then((cfg) => {
        if (!cfg || cfg.off) return;
        if (cfg.httpWarn && location.protocol === 'http:' && !/^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(location.hostname)) watchPasswords();
        if (cfg.amp) leaveAmp();
        if (cfg.unwrap?.length) unwrapLinks(cfg.unwrap);
    });

    // --- Insecure password fields ----------------------------------------------
    function watchPasswords() {
        let shown = false;
        document.addEventListener('focusin', (e) => {
            if (shown || !(e.target instanceof HTMLInputElement) || e.target.type !== 'password') return;
            shown = true;
            toast('This page isn’t secure', 'Anything you type here (including passwords) can be read by others on your network. Only continue if you trust this connection.', 'warn');
            send({ type: 'guard:event', kind: 'insecure-password' });
        }, true);
    }

    // --- AMP -> original page ------------------------------------------------------
    function leaveAmp() {
        const go = () => {
            const html = document.documentElement;
            if (!html || !(html.hasAttribute('amp') || html.hasAttribute('⚡'))) return;
            const canon = document.querySelector('link[rel="canonical"]')?.href;
            if (!canon || canon === location.href) return;
            try {
                const u = new URL(canon);
                if (!/^https?:$/.test(u.protocol) || u.href === location.href) return;
                send({ type: 'guard:event', kind: 'amp' });
                location.replace(u.href);
            } catch { /* ignore */ }
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true }); else go();
    }

    // --- Tracking links: show and use the real destination ------------------------
    function unwrapLinks(patterns) {
        const compiled = patterns.map((p) => ({ re: new RegExp(p.re, 'i'), params: p.params }));
        const real = (href) => {
            for (const p of compiled) {
                if (!p.re.test(href)) continue;
                try {
                    const u = new URL(href);
                    for (const name of p.params) {
                        const v = name === '*' ? decodeURIComponent(u.search.slice(1)) : u.searchParams.get(name);
                        if (v && /^https?:\/\//i.test(v)) return v;
                    }
                } catch { /* ignore */ }
            }
            return null;
        };
        const fix = (a) => {
            if (!a || a.tagName !== 'A' || a.__dxb) return;
            const target = real(a.href);
            a.__dxb = 1;
            if (!target) return;
            a.href = target;
            a.removeAttribute('ping');
            a.setAttribute('data-dxblock', 'unwrapped');
        };
        for (const t of ['mouseover', 'focusin', 'mousedown', 'touchstart']) {
            document.addEventListener(t, (e) => fix(e.target.closest?.('a[href]')), { capture: true, passive: true });
        }
    }

    // --- Toast ---------------------------------------------------------------------
    function toast(title, text, kind) {
        const host = document.createElement('dxblock-toast');
        host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
        const root = host.attachShadow({ mode: 'closed' });
        root.innerHTML = `<style>
            .t{font:13px/1.45 system-ui,sans-serif;color:#f4f4f6;background:#121216;border:1px solid ${kind === 'warn' ? 'rgba(255,176,32,.5)' : 'rgba(229,9,20,.45)'};
               border-radius:14px;padding:12px 14px 12px 12px;max-width:340px;display:flex;gap:10px;box-shadow:0 14px 40px rgba(0,0,0,.5);animation:in .35s cubic-bezier(.2,.9,.3,1)}
            @keyframes in{from{transform:translateY(12px);opacity:0}}
            svg{width:26px;height:26px;flex:none;fill:#e50914} b{display:block;margin-bottom:2px} small{color:#8d8d99;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
            button{all:unset;cursor:pointer;color:#8d8d99;font-size:18px;line-height:1;margin-left:4px}</style>
            <div class="t"><svg viewBox="0 0 128 128"><path d="M64 10 L108 26 V62 C108 90 89 108 64 118 C39 108 20 90 20 62 V26 Z"/></svg>
            <div><small>dx.block</small><b></b><span></span></div><button aria-label="Dismiss">×</button></div>`;
        root.querySelector('b').textContent = title;
        root.querySelector('span').textContent = text;
        root.querySelector('button').onclick = () => host.remove();
        (document.body || document.documentElement).appendChild(host);
        setTimeout(() => host.remove(), 12000);
    }
})();
