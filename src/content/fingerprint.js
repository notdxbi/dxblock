// dx.block anti-fingerprinting (page world, document_start).
// Adds tiny, consistent-per-site-and-session noise to the APIs fingerprinting scripts read (canvas, WebGL,
// audio, text metrics) and rounds identifying hardware values, so sites can't build a stable ID from them.
// Real use (drawing, video, games, audio) is unaffected: noise only touches values read back by scripts.
(() => {
    if (window.__dxbFp) return;
    Object.defineProperty(window, '__dxbFp', { value: true });

    // Per-tab-session, per-site seed (sessionStorage is per origin and per tab)
    let seed;
    try {
        const k = '⁣dxb';
        seed = Number(sessionStorage.getItem(k));
        if (!seed) { seed = (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0) || 1; sessionStorage.setItem(k, String(seed)); }
    } catch { seed = (Math.random() * 2 ** 32) >>> 0 || 1; }
    const rand = (n) => {                       // deterministic 0..1 from seed + n (mulberry32)
        let t = (seed + Math.imul(n | 0, 0x9e3779b9)) >>> 0;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Tell the extension (via the isolated-world guard script), at most once per API per page
    const told = new Set();
    const report = (api) => {
        if (told.has(api)) return;
        told.add(api);
        try { document.dispatchEvent(new CustomEvent('dxb-fp', { detail: api })); } catch { /* ignore */ }
    };

    // Make patched functions look native to toString() checks
    const nativeToString = Function.prototype.toString;
    const disguised = new WeakMap();
    const patch = (obj, name, make) => {
        const orig = obj?.[name];
        if (typeof orig !== 'function') return;
        const fn = make(orig);
        disguised.set(fn, nativeToString.call(orig));
        try { Object.defineProperty(obj, name, { ...Object.getOwnPropertyDescriptor(obj, name), value: fn }); } catch { /* frozen */ }
    };
    patch(Function.prototype, 'toString', (orig) => function toString() { return disguised.get(this) ?? orig.call(this); });

    // --- Canvas ---------------------------------------------------------------
    const noisePixels = (data, w) => {
        // Flip the lowest bit of a few dozen pixels in a pattern that depends on the seed
        const n = Math.min(64, Math.max(4, data.length >> 12));
        for (let i = 0; i < n; i++) {
            const px = Math.floor(rand(i + w) * (data.length / 4)) * 4;
            data[px] ^= 1; data[px + 1] ^= (rand(i + 7) > 0.5 ? 1 : 0); data[px + 2] ^= 1;
        }
    };
    const getImageData = CanvasRenderingContext2D.prototype.getImageData;
    patch(CanvasRenderingContext2D.prototype, 'getImageData', (orig) => function (...a) {
        const img = orig.apply(this, a);
        if (img.width * img.height > 16) { noisePixels(img.data, img.width); if (img.width * img.height < 250000) report('canvas'); }
        return img;
    });
    const noisyCopy = (canvas) => {
        if (!canvas.width || !canvas.height || canvas.width * canvas.height > 4e6) return null;
        try {
            const copy = document.createElement('canvas');
            copy.width = canvas.width; copy.height = canvas.height;
            const ctx = copy.getContext('2d');
            ctx.drawImage(canvas, 0, 0);
            const img = getImageData.call(ctx, 0, 0, copy.width, copy.height);
            noisePixels(img.data, copy.width);
            ctx.putImageData(img, 0, 0);
            return copy;
        } catch { return null; }
    };
    patch(HTMLCanvasElement.prototype, 'toDataURL', (orig) => function (...a) {
        const c = noisyCopy(this);
        if (c && this.width * this.height < 250000) report('canvas');
        return orig.apply(c || this, a);
    });
    patch(HTMLCanvasElement.prototype, 'toBlob', (orig) => function (...a) {
        const c = noisyCopy(this);
        if (c && this.width * this.height < 250000) report('canvas');
        return orig.apply(c || this, a);
    });

    // --- WebGL ----------------------------------------------------------------
    for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
        if (!proto) continue;
        patch(proto, 'getParameter', (orig) => function (p) {
            // UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL reveal the exact GPU and driver
            if (p === 0x9245) { report('webgl'); return 'Google Inc.'; }
            if (p === 0x9246) { report('webgl'); return 'ANGLE (Generic GPU)'; }
            return orig.call(this, p);
        });
        patch(proto, 'readPixels', (orig) => function (...a) {
            const r = orig.apply(this, a);
            const buf = a[6];
            if (buf && buf.length > 16) { noisePixels(buf, this.drawingBufferWidth || 1); report('webgl'); }
            return r;
        });
    }

    // --- Audio ----------------------------------------------------------------
    if (window.AudioBuffer) {
        patch(AudioBuffer.prototype, 'getChannelData', (orig) => function (ch) {
            const d = orig.call(this, ch);
            if (d.length > 1000 && !d.__dxb) {
                for (let i = 0; i < d.length; i += 97) d[i] += (rand(i) - 0.5) * 1e-7;
                try { Object.defineProperty(d, '__dxb', { value: 1 }); } catch { /* ignore */ }
                report('audio');
            }
            return d;
        });
    }
    if (window.AnalyserNode) {
        patch(AnalyserNode.prototype, 'getFloatFrequencyData', (orig) => function (arr) {
            orig.call(this, arr);
            for (let i = 0; i < arr.length; i += 13) arr[i] += (rand(i) - 0.5) * 1e-4;
            report('audio');
        });
    }

    // --- Text metrics (font fingerprinting) -----------------------------------
    let measured = 0;   // font probing measures the same text in hundreds of fonts: only that counts as an attempt
    patch(CanvasRenderingContext2D.prototype, 'measureText', (orig) => function (text) {
        const m = orig.call(this, text);
        const jitter = (rand(String(text).length + 31) - 0.5) * 0.004;
        try {
            const w = m.width + jitter;
            Object.defineProperty(m, 'width', { get: () => w });
        } catch { /* ignore */ }
        if (++measured > 150) report('fonts');
        return m;
    });

    // --- Hardware values --------------------------------------------------------
    const define = (proto, prop, value) => {
        try { Object.defineProperty(proto, prop, { get: () => value, configurable: true }); } catch { /* ignore */ }
    };
    const cores = navigator.hardwareConcurrency || 4;
    define(Navigator.prototype, 'hardwareConcurrency', cores > 8 ? 8 : cores > 4 ? 4 : cores);
    if ('deviceMemory' in Navigator.prototype) define(Navigator.prototype, 'deviceMemory', 8);
    if (navigator.getBattery) patch(Navigator.prototype, 'getBattery', () => function getBattery() {
        report('battery');
        return Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1, addEventListener() {}, removeEventListener() {} });
    });
})();
