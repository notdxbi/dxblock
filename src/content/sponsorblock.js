// dx.block: skip sponsor segments on YouTube using the community SponsorBlock database (sponsor.ajay.app).
// Privacy: only the first 4 characters of a SHA-256 hash of the video ID are sent, so the server can't tell which video you watch.
(() => {
    if (window.__dxbSponsor) return;
    window.__dxbSponsor = true;
    const CATEGORIES = ['sponsor', 'selfpromo', 'interaction'];
    let videoId = null;
    let segments = [];

    const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    async function load(id) {
        segments = [];
        try {
            const prefix = (await sha256(id)).slice(0, 4);
            const r = await fetch(`https://sponsor.ajay.app/api/skipSegments/${prefix}?categories=${encodeURIComponent(JSON.stringify(CATEGORIES))}`);
            if (!r.ok) return;
            const all = await r.json();
            segments = (all.find((v) => v.videoID === id)?.segments || []).map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category }));
        } catch { /* offline or blocked */ }
    }
    function current() {
        try {
            const u = new URL(location.href);
            return u.searchParams.get('v') || (u.pathname.startsWith('/shorts/') ? null : null);
        } catch { return null; }
    }
    function toast(text) {
        const el = document.createElement('div');
        el.textContent = text;
        el.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483647;background:rgba(18,18,22,.92);color:#fff;font:600 13px system-ui,sans-serif;padding:8px 14px;border-radius:99px;border:1px solid rgba(229,9,20,.5);pointer-events:none;transition:opacity .4s';
        document.documentElement.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 500); }, 1800);
    }
    setInterval(async () => {
        const id = current();
        if (id !== videoId) { videoId = id; if (id) await load(id); }
        const v = document.querySelector('video');
        if (!v || !segments.length || v.paused) return;
        const seg = segments.find((s) => v.currentTime >= s.start && v.currentTime < s.end - 0.3);
        if (!seg) return;
        v.currentTime = seg.end;
        toast(`dx.block skipped a ${seg.category === 'selfpromo' ? 'self-promotion' : seg.category === 'interaction' ? 'subscribe reminder' : 'sponsor'} segment`);
        chrome.runtime.sendMessage({ type: 'guard:event', kind: 'sponsor' }).catch(() => {});
    }, 400);
})();
