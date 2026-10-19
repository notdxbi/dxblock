// Tracking redirect (google.com/url, l.facebook.com, out.reddit.com, ...) was intercepted: go straight to the destination.
(() => {
    const wrapped = decodeURIComponent(location.hash.slice(1));
    let target = null;
    try {
        const u = new URL(wrapped);
        for (const name of ['q', 'url', 'u', 'to', 'uddg', 'target', 'dest', 'redirect']) {
            const v = u.searchParams.get(name);
            if (v && /^https?:\/\//i.test(v)) { target = v; break; }
        }
        if (!target) {
            const raw = decodeURIComponent(u.search.slice(1));
            if (/^https?:\/\//i.test(raw)) target = raw;
        }
    } catch { /* ignore */ }
    const link = document.getElementById('link');
    if (target) {
        chrome.runtime.sendMessage({ type: 'guard:event', kind: 'unwrap' }).catch(() => {});
        location.replace(target);
    } else {
        link.textContent = 'Open the original link';
        link.href = wrapped;
        document.querySelector('p').textContent = 'dx.block couldn’t find where this link goes.';
    }
})();
