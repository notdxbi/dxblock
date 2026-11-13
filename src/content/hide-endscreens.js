// dx.block distractions: removes the video suggestions YouTube lays over the end of a video
// (end-screen cards, the wall of videos when it finishes, and info cards popping in during playback).
(() => {
    if (window.__dxbNoEnd) return;
    window.__dxbNoEnd = true;
    const css = document.createElement('style');
    css.textContent = `
        .ytp-ce-element, .ytp-ce-covering-overlay, .ytp-endscreen-content, .ytp-endscreen-previous, .ytp-endscreen-next,
        .html5-endscreen, .videowall-endscreen, .ytp-fullscreen-grid, .ytp-fullscreen-grid-peeking, .ytp-fullerscreen-edu-button,
        .ytp-cards-teaser, .ytp-cards-button, .iv-branding, .ytp-autonav-endscreen-upnext-container { display: none !important; }`;
    (document.head || document.documentElement).appendChild(css);
})();
