// dx.block "blend in": sites see UTC and US English instead of your real timezone and languages
// (the Tor Browser approach). Pair it with a proxy so your IP's location matches.
(() => {
    if (window.__dxbBlend) return;
    Object.defineProperty(window, '__dxbBlend', { value: true });
    try {
        const ro = Intl.DateTimeFormat.prototype.resolvedOptions;
        Intl.DateTimeFormat.prototype.resolvedOptions = function resolvedOptions() { return { ...ro.call(this), timeZone: 'UTC' }; };
        Date.prototype.getTimezoneOffset = function getTimezoneOffset() { return 0; };
        Object.defineProperty(Navigator.prototype, 'language', { get: () => 'en-US', configurable: true });
        Object.defineProperty(Navigator.prototype, 'languages', { get: () => Object.freeze(['en-US', 'en']), configurable: true });
    } catch { /* ignore */ }
})();
