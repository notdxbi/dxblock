// dx.block distractions: removes YouTube Shorts (shelves, the sidebar entry, Shorts in search and subscriptions)
// and opens any Shorts link as a normal video instead.
(() => {
    if (window.__dxbNoShorts) return;
    window.__dxbNoShorts = true;
    const css = document.createElement('style');
    css.textContent = `
        ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts], ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
        ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model), grid-shelf-view-model:has(ytm-shorts-lockup-view-model),
        ytd-guide-entry-renderer:has(a[title="Shorts"]), ytd-mini-guide-entry-renderer[aria-label="Shorts"],
        ytd-video-renderer:has(a[href^="/shorts/"]), ytd-grid-video-renderer:has(a[href^="/shorts/"]), ytd-rich-item-renderer:has(a[href^="/shorts/"]),
        ytd-compact-video-renderer:has(a[href^="/shorts/"]), yt-lockup-view-model:has(a[href^="/shorts/"]),
        yt-chip-cloud-chip-renderer:has(yt-formatted-string[title="Shorts"]), yt-tab-shape[tab-title="Shorts"],
        ytm-reel-shelf-renderer, ytm-shorts-lockup-view-model, ytm-pivot-bar-item-renderer:has(.pivot-shorts) { display: none !important; }`;
    (document.head || document.documentElement).appendChild(css);
    const leave = () => {
        const m = location.pathname.match(/^\/shorts\/([\w-]{6,20})/);
        if (m) location.replace(`/watch?v=${m[1]}`);
    };
    leave();
    document.addEventListener('yt-navigate-finish', leave);
    window.addEventListener('popstate', leave);
})();
