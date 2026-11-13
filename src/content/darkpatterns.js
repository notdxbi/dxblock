// dx.block dark-pattern spotter: outlines manipulation tricks (fake countdowns, "only 2 left!", guilt-trip
// "No thanks, I hate saving money" buttons, pre-ticked marketing boxes) and says what each one is.
// Reads text only; it never clicks or changes anything on the page.
(() => {
    if (window.__dxbDark || window.top !== window) return;
    window.__dxbDark = true;

    const RULES = [
        { kind: 'scarcity', label: 'Pressure: claims stock is running out', re: /\b(only|just)\s+\d{1,3}\s+(left|remaining|available|in stock|seats? left|rooms? left)\b|\b(selling fast|almost gone|going fast|high demand|low stock|limited stock|nearly sold out)\b/i },
        { kind: 'social', label: 'Pressure: "other people are looking" claim', re: /\b\d{1,5}\s+(people|others|users|shoppers|travell?ers|customers)\s+(are\s+)?(viewing|looking at|watching|browsing|have this in|looked at this)|\b\d{1,5}\s+(sold|bought|booked|purchased)\s+in\s+(the\s+)?(last|past)\s+\d+\s*(minutes?|mins?|hours?|hrs?)\b|\bin\s+\d{1,5}\s+(other\s+)?(people['’]s\s+)?(baskets|carts)\b/i },
        { kind: 'urgency', label: 'Pressure: deadline to rush you', re: /\b(hurry|last chance|offer ends (soon|today|tonight)|ends in \d|deal ends|price goes up|today only|expires in \d|reserved for (the next )?\d+\s*min)/i }
    ];
    const SHAME = /^\s*no,?\s*(thanks|thank you)?[,.!…\s-]*\s*i\s*(don['’]t|do not|prefer|['’]d rather|would rather|hate|am not|['’]m not|like paying|will pay|want to pay|enjoy)\b|\bi\s+(don['’]t|do not)\s+(want|like|care about|need)\s+(to\s+)?(save|saving|savings|money|deals|discounts?|free|protect|security|my health)|\bi\s+(prefer|['’]d rather)\s+(to\s+)?(pay full|miss out|stay|lose|pay more)|\b(hate|don['’]t like)\s+(saving|deals|discounts|free stuff)\b/i;
    const PRETICK = /newsletter|marketing|offers|promotions?|partners|third[- ]part|subscribe|special deals|share my|send me|keep me (updated|informed)|e-?mail me|sms|text messages/i;
    const TIME = /^\s*(\d{1,2}\s*[:hH]\s*)?\d{1,2}\s*[:mM]\s*\d{2}\s*[sS]?\s*$|^\s*\d{1,2}\s*h\s*\d{1,2}\s*m(\s*\d{1,2}\s*s)?\s*$/;
    const NEAR_DEADLINE = /ends|expires|left|offer|deal|sale|hurry|reserved|held|remaining|countdown|only/i;

    const found = new Set();
    const marked = new WeakSet();
    let total = 0;

    const style = document.createElement('style');
    style.textContent = `[data-dxb-dark]{outline:2px dashed #ffb020 !important;outline-offset:2px !important;border-radius:2px}`;

    function mark(el, kind, label) {
        if (!el || marked.has(el) || total >= 30) return;
        marked.add(el);
        total++;
        if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
        el.setAttribute('data-dxb-dark', kind);
        if (!el.title) el.title = `dx.block: ${label}`;
        const key = `${kind}`;
        chrome.runtime.sendMessage({ type: 'guard:event', kind: 'dark', detail: label }).catch(() => null);
        found.add(key);
    }

    const box = (n) => {
        let el = n.parentElement;
        // climb to a small block so the outline wraps the message, not one word
        while (el && el.parentElement && (el.textContent || '').length < 12 && el !== document.body) el = el.parentElement;
        return el;
    };
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

    function scanText(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (n) => {
                const p = n.parentElement;
                if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|TEMPLATE|CODE|PRE)$/.test(p.tagName) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
                const t = n.nodeValue;
                return t.length > 3 && t.length < 400 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
        });
        const clocks = [];
        let n, seen = 0;
        while ((n = walker.nextNode()) && seen++ < 15000) {
            const t = n.nodeValue;
            for (const r of RULES) if (r.re.test(t)) { const el = box(n); if (el && shown(el)) mark(el, r.kind, r.label); break; }
            if (TIME.test(t) && clocks.length < 20) clocks.push(n.parentElement);
        }
        if (clocks.length) checkCountdowns(clocks);
    }

    // A real countdown: the text ticks down and there's deadline wording nearby
    function checkCountdowns(els) {
        const before = els.map((el) => el.textContent);
        setTimeout(() => {
            els.forEach((el, i) => {
                if (!el.isConnected || el.textContent === before[i] || marked.has(el)) return;
                let ctx = el;
                for (let k = 0; k < 4 && ctx.parentElement; k++) ctx = ctx.parentElement;
                if (!NEAR_DEADLINE.test((ctx.textContent || '').slice(0, 400))) return;
                mark(ctx.contains(el) && (ctx.textContent || '').length < 300 ? ctx : el, 'countdown', 'Countdown timer to rush you (often resets when you reload)');
            });
        }, 2200);
    }

    function scanControls(root) {
        for (const el of root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')) {
            const t = (el.innerText || el.value || '').trim();
            if (t.length > 8 && t.length < 120 && SHAME.test(t) && shown(el)) mark(el, 'shame', 'Guilt-trip button: the "no" option is worded to make you feel bad');
        }
        for (const cb of root.querySelectorAll('input[type="checkbox"]')) {
            if (!cb.defaultChecked || !cb.checked || marked.has(cb)) continue;
            const label = cb.labels?.[0]?.innerText || cb.closest('label')?.innerText || cb.parentElement?.innerText || '';
            if (PRETICK.test(label.slice(0, 300))) mark(cb.closest('label') || cb.parentElement || cb, 'pretick', 'Pre-ticked box: signs you up for marketing unless you untick it');
        }
    }

    let scans = 0;
    let timer = 0;
    function scan() {
        if (!document.body || scans++ > 6 || total >= 30) return mo?.disconnect();
        scanText(document.body);
        scanControls(document.body);
    }
    let mo = null;

    chrome.runtime.sendMessage({ type: 'guard:init' }).then((cfg) => {
        if (!cfg || cfg.off) return;
        const start = () => {
            const idle = window.requestIdleCallback || ((f) => setTimeout(f, 300));
            idle(scan, { timeout: 2000 });
            mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => idle(scan, { timeout: 2000 }), 1500); });
            mo.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(() => mo?.disconnect(), 60_000);
        };
        if (document.readyState === 'complete') start(); else addEventListener('load', start, { once: true });
    }).catch(() => null);
})();
