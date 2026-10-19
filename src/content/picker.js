// dx.block element picker: point at something, click, pick how specific the rule is, block it.
(() => {
    if (window.__dxbPicker) { window.__dxbPicker.focus(); return; }

    const host = document.createElement('dxblock-picker');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .box { position: fixed; pointer-events: none; border: 2px solid #e50914; background: rgba(229,9,20,.18);
         border-radius: 4px; transition: all .06s ease-out; display: none; }
  .tip { position: fixed; pointer-events: none; background: #141414; color: #fff; font: 12px/1.4 ui-monospace, monospace;
         padding: 4px 8px; border-radius: 6px; max-width: 60vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
         box-shadow: 0 4px 16px rgba(0,0,0,.4); display: none; }
  .panel { position: fixed; right: 16px; bottom: 16px; width: min(420px, calc(100vw - 32px)); pointer-events: auto;
           background: #141414; color: #eee; border: 1px solid #2a2a2a; border-radius: 14px; padding: 14px;
           box-shadow: 0 12px 40px rgba(0,0,0,.55); font-size: 13px; }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .logo { font-weight: 800; letter-spacing: .5px; }
  .logo b { color: #e50914; }
  .hint { color: #999; font-size: 12px; margin-left: auto; }
  .list { display: flex; flex-direction: column; gap: 6px; max-height: 40vh; overflow: auto; }
  label { display: flex; gap: 8px; align-items: center; padding: 7px 9px; border-radius: 8px; background: #1d1d1d; cursor: pointer; }
  label:hover { background: #262626; }
  label input { accent-color: #e50914; }
  code { font: 12px ui-monospace, monospace; color: #fff; word-break: break-all; flex: 1; }
  .n { color: #999; font-size: 11px; white-space: nowrap; }
  .row { display: flex; gap: 8px; margin-top: 12px; }
  button { flex: 1; border: 0; border-radius: 8px; padding: 9px 10px; font-weight: 600; font-size: 13px; cursor: pointer;
           background: #2a2a2a; color: #eee; }
  button:hover { background: #333; }
  button.primary { background: #e50914; color: #fff; }
  button.primary:hover { background: #f6121d; }
  .nav { display: flex; gap: 6px; margin-top: 8px; }
  .nav button { padding: 6px; font-size: 12px; }
  .empty { color: #aaa; padding: 6px 2px; }
</style>
<div class="box"></div>
<div class="tip"></div>
<div class="panel">
  <div class="head"><span class="logo">dx<b>.</b>block</span><span class="hint">Click an element · Esc to quit</span></div>
  <div class="list"><div class="empty">Hover over the thing you want gone and click it.</div></div>
  <div class="nav" hidden><button data-a="up">▲ Wider (parent)</button><button data-a="down">▼ Narrower</button></div>
  <div class="row"><button data-a="cancel">Cancel</button><button data-a="create" class="primary" disabled>Block element</button></div>
</div>`;
    (document.documentElement || document.body).appendChild(host);

    const box = root.querySelector('.box');
    const tip = root.querySelector('.tip');
    const panel = root.querySelector('.panel');
    const list = root.querySelector('.list');
    const nav = root.querySelector('.nav');
    const createBtn = root.querySelector('[data-a="create"]');
    const preview = document.createElement('style');
    preview.setAttribute('data-dxblock', 'preview');

    let picking = true;
    let target = null;
    let trail = [];          // elements from the clicked one up to <body>, for wider/narrower
    let depth = 0;
    let chosen = '';

    const randomish = (s) => /\d{4,}|[0-9a-f]{8,}|^[a-z]{1,2}\d|--|__[a-z0-9]{5,}$/i.test(s);
    const esc = (s) => CSS.escape(s);

    function candidates(el) {
        const out = [];
        const tag = el.localName;
        if (el.id && !randomish(el.id)) out.push(`#${esc(el.id)}`);
        const classes = [...el.classList].filter((c) => !randomish(c) && c.length < 40);
        if (classes.length) {
            out.push(`${tag}.${classes.map(esc).join('.')}`);
            for (const c of classes.slice(0, 3)) out.push(`.${esc(c)}`);
        }
        for (const a of ['src', 'href', 'data-ad', 'data-ad-slot', 'aria-label']) {
            const v = el.getAttribute?.(a);
            if (v && v.length < 120) {
                const short = a === 'src' || a === 'href' ? v.replace(/^https?:\/\//, '').split(/[?#]/)[0].slice(0, 60) : v;
                out.push(`${tag}[${a}${a === 'src' || a === 'href' ? '*' : ''}="${short.replace(/"/g, '\\"')}"]`);
            }
        }
        // Structural path as a fallback
        const parts = [];
        let n = el;
        for (let i = 0; n && n.nodeType === 1 && n !== document.body && i < 5; i++, n = n.parentElement) {
            let p = n.localName;
            if (n.id && !randomish(n.id)) { parts.unshift(`#${esc(n.id)}`); break; }
            const sib = n.parentElement ? [...n.parentElement.children].filter((x) => x.localName === n.localName) : [];
            if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(n) + 1})`;
            parts.unshift(p);
        }
        out.push(parts.join(' > '));
        return [...new Set(out)].filter((s) => { try { return document.querySelector(s); } catch { return false; } });
    }

    const count = (sel) => { try { return document.querySelectorAll(sel).length; } catch { return 0; } };

    function highlight(el) {
        if (!el || el === host) { box.style.display = tip.style.display = 'none'; return; }
        const r = el.getBoundingClientRect();
        Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        tip.textContent = candidates(el)[0] || el.localName;
        Object.assign(tip.style, { display: 'block', left: `${Math.max(4, r.left)}px`, top: `${r.top > 28 ? r.top - 26 : r.bottom + 4}px` });
    }

    function setPreview(sel) {
        chosen = sel;
        createBtn.disabled = !sel;
        preview.textContent = sel ? `${sel}{outline:2px dashed #e50914!important;opacity:.25!important}` : '';
        if (!preview.isConnected) (document.head || document.documentElement).appendChild(preview);
    }

    function showChoices() {
        const el = trail[depth];
        highlight(el);
        const cands = candidates(el);
        list.innerHTML = '';
        cands.forEach((sel, i) => {
            const label = document.createElement('label');
            const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'sel', checked: i === 0 });
            const code = Object.assign(document.createElement('code'), { textContent: sel });
            const n = Object.assign(document.createElement('span'), { className: 'n', textContent: `${count(sel)} on page` });
            input.addEventListener('change', () => setPreview(sel));
            label.append(input, code, n);
            list.append(label);
        });
        nav.hidden = false;
        setPreview(cands[0] || '');
    }

    function onMove(e) {
        if (!picking) return;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && el !== host) { target = el; highlight(el); }
    }
    function onClick(e) {
        if (e.composedPath().includes(host)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!picking || !target) return;
        picking = false;
        trail = [];
        for (let n = target; n && n !== document.documentElement; n = n.parentElement) trail.push(n);
        depth = 0;
        showChoices();
    }
    const swallow = (e) => { if (!e.composedPath().includes(host)) { e.preventDefault(); e.stopImmediatePropagation(); } };

    function quit() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu']) document.removeEventListener(t, swallow, true);
        document.removeEventListener('keydown', onKey, true);
        preview.remove();
        host.remove();
        delete window.__dxbPicker;
    }
    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); quit(); }
        if (e.key === 'Enter' && chosen) { e.preventDefault(); create(); }
    }
    async function create() {
        if (!chosen) return;
        const sel = chosen;
        quit();
        const style = document.createElement('style');
        style.textContent = `${sel}{display:none!important}`;
        (document.head || document.documentElement).appendChild(style);
        await chrome.runtime.sendMessage({ type: 'picker:create', selector: sel }).catch(() => {});
    }

    root.addEventListener('click', (e) => {
        const a = e.target.closest?.('[data-a]')?.dataset.a;
        if (a === 'cancel') quit();
        if (a === 'create') create();
        if (a === 'up' && depth < trail.length - 1) { depth++; showChoices(); }
        if (a === 'down') {
            if (depth > 0) { depth--; showChoices(); }
            else { picking = true; nav.hidden = true; list.innerHTML = '<div class="empty">Pick again: hover and click.</div>'; setPreview(''); }
        }
    });

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu']) document.addEventListener(t, swallow, true);
    document.addEventListener('keydown', onKey, true);
    window.__dxbPicker = { focus: () => panel.scrollIntoView() };
})();
