// dx.block clipboard guard (page world): stops sites from secretly changing what you copy.
//  - "Read more at example.com…" tails glued onto copied text are removed
//  - a copied crypto wallet, IBAN or card number can't be swapped for a different one
//  - the page can't write to your clipboard unless you just clicked or pressed a key
// Reports to content/guard.js through a 'dxb-clip' DOM event (guard.js shows the notice).
(() => {
    if (window.__dxbClip) return;
    Object.defineProperty(window, '__dxbClip', { value: true });
    const report = (what) => document.dispatchEvent(new CustomEvent('dxb-clip', { detail: what }));
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const SENSITIVE = /^(?:(?:bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}|0x[a-fA-F0-9]{40}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}|T[1-9A-HJ-NP-Za-km-z]{33}|[1-9A-HJ-NP-Za-km-z]{32,44}|4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}|[A-Z]{2}\d{2}[A-Z0-9 ]{11,32}|(?:\d[ -]?){13,19})$/;

    let copying = null;   // selection text while a copy/cut event is being handled
    const onCopy = () => {
        copying = String(window.getSelection?.() || '');
        setTimeout(() => { copying = null; }, 0);
    };
    window.addEventListener('copy', onCopy, true);
    window.addEventListener('cut', onCopy, true);

    const proto = DataTransfer.prototype;
    const setData = proto.setData;
    proto.setData = new Proxy(setData, {
        apply(fn, dt, args) {
            const [type, value] = args;
            const sel = copying;
            if (sel && norm(sel) && typeof value === 'string') {
                const t = String(type).toLowerCase();
                const plain = t === 'text/html' ? norm(value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')) : norm(value);
                const s = norm(sel);
                if (plain !== s) {
                    if (plain.includes(s) && plain.length > s.length + 15) {
                        // Extra text glued on: keep only what you selected
                        report('append');
                        if (t === 'text/html') return undefined;
                        return Reflect.apply(fn, dt, [type, sel]);
                    }
                    if (SENSITIVE.test(s) && (t === 'text/plain' || t === 'text')) {
                        report('swap');
                        return Reflect.apply(fn, dt, [type, sel]);
                    }
                }
            }
            return Reflect.apply(fn, dt, args);
        }
    });

    // Clipboard writes need a fresh click or key press
    const active = () => !navigator.userActivation || navigator.userActivation.isActive;
    const clip = navigator.clipboard && Object.getPrototypeOf(navigator.clipboard);
    for (const name of ['writeText', 'write']) {
        const orig = clip?.[name];
        if (typeof orig !== 'function') continue;
        clip[name] = new Proxy(orig, {
            apply(fn, self, args) {
                if (!active()) {
                    report('silent');
                    return Promise.reject(new DOMException('Clipboard write blocked by dx.block: no user action', 'NotAllowedError'));
                }
                return Reflect.apply(fn, self, args);
            }
        });
    }
})();
