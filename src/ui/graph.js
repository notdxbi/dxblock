// dx.block live tracker web: the site in the middle, tracking companies orbiting it, and every blocked request
// flying in from the edge until a tendril shoots out, grabs it and pins it to its company's web.
const COLORS = {
    ad: '#ff3b45', stealth: '#ff3b45', tracker: '#a970ff', threat: '#ffb020', popup: '#2fb7ff',
    fp: '#ff6b9a', phishing: '#ffb020', unwrapped: '#22d38a', amp: '#22d38a', sponsor: '#22d38a', cleaned: '#22d38a', param: '#8d8d99'
};
const LABELS = { fp: 'Fingerprinting blocked', phishing: 'Fake site warning', unwrapped: 'Tracking link skipped', amp: 'AMP skipped', sponsor: 'Sponsor skipped', cleaned: 'Site data deleted', param: 'Link tracker removed' };

export class TrackerWeb {
    constructor(canvas, { labels = false, maxNodes = 36, reduced = false } = {}) {
        this.c = canvas;
        this.ctx = canvas.getContext('2d');
        this.labels = labels;
        this.maxNodes = maxNodes;
        this.reduced = reduced;
        this.hubs = new Map();        // company -> hub
        this.nodes = new Map();       // host -> node
        this.flying = [];             // incoming particles
        this.bursts = [];             // center bursts for non-request events
        this.floaters = [];           // floating text
        this.t0 = performance.now();
        this.hover = null;
        this.paused = false;
        this.resize();
        new ResizeObserver(() => this.resize()).observe(canvas);
        if (labels) {
            canvas.addEventListener('mousemove', (e) => { const r = canvas.getBoundingClientRect(); this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; });
            canvas.addEventListener('mouseleave', () => { this.mouse = null; });
        }
        const loop = (t) => { this.frame(t); this.raf = requestAnimationFrame(loop); };
        this.raf = requestAnimationFrame(loop);
    }

    resize() {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const { width, height } = this.c.getBoundingClientRect();
        this.w = width; this.h = height;
        this.c.width = Math.max(1, width * dpr);
        this.c.height = Math.max(1, height * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.cx = width / 2; this.cy = height / 2;
        this.R = Math.min(width, height) / 2;
        this.layout();
    }

    layout() {
        const hubs = [...this.hubs.values()];
        hubs.forEach((h, i) => {
            h.angle = -Math.PI / 2 + (i / Math.max(1, hubs.length)) * Math.PI * 2;
            h.tx = this.cx + Math.cos(h.angle) * this.R * 0.46;
            h.ty = this.cy + Math.sin(h.angle) * this.R * 0.46;
        });
        for (const n of this.nodes.values()) this.place(n);
    }

    hub(company) {
        const name = company || 'Other';
        let h = this.hubs.get(name);
        if (!h) {
            h = { name, x: this.cx, y: this.cy, tx: this.cx, ty: this.cy, count: 0, born: performance.now(), children: 0 };
            this.hubs.set(name, h);
            // Keep the busiest companies; fold the rest into "Other"
            if (this.hubs.size > (this.labels ? 12 : 8)) {
                const victim = [...this.hubs.values()].filter((x) => x.name !== 'Other' && x !== h).sort((a, b) => a.count - b.count)[0];
                if (victim) {
                    this.hubs.delete(victim.name);
                    for (const n of this.nodes.values()) if (n.hub === victim) n.hub = this.hub('Other');
                }
            }
            this.layout();
        }
        return h;
    }

    place(n) {
        const h = n.hub;
        // Fan the company's domains out in rings so busy companies don't pile up
        const spread = Math.min(1.1, (Math.PI * 2) / Math.max(3, this.hubs.size) * 0.85);
        const k = n.slot;
        const ring = Math.floor(k / 6) % 3;
        const a = h.angle + (((k % 6) - 2.5) / 6) * spread + ring * 0.07;
        const r = this.R * (0.64 + ring * 0.13);
        n.tx = this.cx + Math.cos(a) * r;
        n.ty = this.cy + Math.sin(a) * r;
    }

    // A blocked request: kind = ad | tracker | threat | popup | stealth
    add({ host, kind = 'ad', company = null }) {
        if (kind === 'param' || LABELS[kind]) return this.burst(kind, host);
        const h = this.hub(company);
        h.count++;
        let n = this.nodes.get(host);
        const color = COLORS[kind] || COLORS.ad;
        if (n) {
            n.count++;
            n.pulse = 1;
        } else {
            if (this.nodes.size >= this.maxNodes) {
                const oldest = [...this.nodes.values()].sort((a, b) => a.last - b.last)[0];
                this.nodes.delete(oldest.host);
            }
            n = { host, kind, color, hub: h, slot: h.children++, count: 1, x: 0, y: 0, tx: 0, ty: 0, pulse: 1, captured: false, last: 0 };
            this.place(n);
            this.nodes.set(host, n);
        }
        n.last = performance.now();
        if (this.reduced) { n.captured = true; n.x = n.tx; n.y = n.ty; return; }
        // Incoming particle from the edge
        const a = Math.atan2(n.ty - this.cy, n.tx - this.cx) + (Math.random() - 0.5) * 0.8;
        const d = this.R * 1.25;
        this.flying.push({ node: n, x: this.cx + Math.cos(a) * d, y: this.cy + Math.sin(a) * d, t: 0, color });
    }

    burst(kind, text) {
        if (this.reduced) return;
        this.bursts.push({ color: COLORS[kind] || '#22d38a', t: 0 });
        if (LABELS[kind]) this.floaters.push({ text: LABELS[kind], color: COLORS[kind], t: 0 });
    }

    frame(now) {
        const { ctx, w, h, cx, cy, R } = this;
        if (!w || !h) return;
        const time = (now - this.t0) / 1000;
        ctx.clearRect(0, 0, w, h);

        // Backdrop: dot grid, rings, sweep
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.045)';
        for (let x = (cx % 18); x < w; x += 18) for (let y = (cy % 18); y < h; y += 18) ctx.fillRect(x, y, 1, 1);
        ctx.strokeStyle = 'rgba(229,9,20,0.16)';
        ctx.lineWidth = 1;
        for (const f of [0.46, 0.74, 0.98]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); }
        if (!this.paused && !this.reduced) {
            const sweep = (time * 1.6) % (Math.PI * 2);
            const g = ctx.createConicGradient ? ctx.createConicGradient(sweep, cx, cy) : null;
            if (g) {
                g.addColorStop(0, 'rgba(255,59,69,0.22)');
                g.addColorStop(0.08, 'rgba(229,9,20,0.05)');
                g.addColorStop(0.2, 'rgba(229,9,20,0)');
                g.addColorStop(1, 'rgba(229,9,20,0)');
                ctx.fillStyle = g;
                ctx.beginPath(); ctx.arc(cx, cy, R * 0.98, 0, Math.PI * 2); ctx.fill();
            }
        }
        ctx.restore();

        // Hubs drift to their slot; web lines center -> hub -> nodes
        for (const hb of this.hubs.values()) { hb.x += (hb.tx - hb.x) * 0.08; hb.y += (hb.ty - hb.y) * 0.08; }
        ctx.lineWidth = 1;
        for (const hb of this.hubs.values()) {
            ctx.strokeStyle = 'rgba(229,9,20,0.28)';
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(hb.x, hb.y); ctx.stroke();
        }
        for (const n of this.nodes.values()) {
            if (!n.captured) continue;
            const wob = this.reduced ? 0 : Math.sin(time * 1.3 + n.slot) * 1.6;
            n.x += (n.tx + wob - n.x) * 0.1; n.y += (n.ty - wob - n.y) * 0.1;
            ctx.strokeStyle = hexA(n.color, 0.35);
            ctx.beginPath(); ctx.moveTo(n.hub.x, n.hub.y); ctx.lineTo(n.x, n.y); ctx.stroke();
        }

        // Incoming particles and the tendrils that grab them
        this.flying = this.flying.filter((p) => {
            p.t += 1 / 42;
            const n = p.node;
            const e = easeOut(Math.min(1, p.t / 0.55));
            const px = p.x + (n.tx - p.x) * e;
            const py = p.y + (n.ty - p.y) * e;
            // particle with trail
            ctx.fillStyle = hexA(p.color, 0.25);
            ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(px, py, 2.6, 0, Math.PI * 2); ctx.fill();
            // tendril from the hub
            if (p.t > 0.25) {
                const k = Math.min(1, (p.t - 0.25) / 0.35);
                const hx = n.hub.x, hy = n.hub.y;
                const mx = (hx + px) / 2 + (py - hy) * 0.25, my = (hy + py) / 2 - (px - hx) * 0.25;
                ctx.strokeStyle = 'rgba(255,59,69,0.9)';
                ctx.lineWidth = 1.6;
                ctx.shadowColor = '#ff3b45'; ctx.shadowBlur = 8;
                ctx.beginPath(); ctx.moveTo(hx, hy);
                const steps = 14;
                for (let i = 1; i <= steps * k; i++) {
                    const s = i / steps;
                    ctx.lineTo((1 - s) ** 2 * hx + 2 * (1 - s) * s * mx + s * s * px, (1 - s) ** 2 * hy + 2 * (1 - s) * s * my + s * s * py);
                }
                ctx.stroke();
                ctx.shadowBlur = 0;
            }
            if (p.t >= 0.62) {
                n.captured = true; n.x = px; n.y = py; n.pulse = 1;
                return false;
            }
            return true;
        });

        // Captured nodes (labels skip spots that are already taken)
        const taken = [];
        const free = (x, y, w, h) => {
            if (taken.some((b) => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y)) return false;
            taken.push({ x, y, w, h });
            return true;
        };
        for (const hb of this.hubs.values()) taken.push({ x: hb.x - 40, y: hb.y - 22, w: 80, h: 44 });
        for (const n of this.nodes.values()) {
            if (!n.captured) continue;
            const r = 2.6 + Math.min(5, Math.log2(n.count + 1) * 1.4);
            if (n.pulse > 0) {
                ctx.strokeStyle = hexA(n.color, n.pulse);
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(n.x, n.y, r + (1 - n.pulse) * 14, 0, Math.PI * 2); ctx.stroke();
                n.pulse = Math.max(0, n.pulse - 0.03);
            }
            ctx.fillStyle = hexA(n.color, 0.22);
            ctx.beginPath(); ctx.arc(n.x, n.y, r + 3, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = n.color;
            ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
            // "blocked" slash
            ctx.strokeStyle = 'rgba(8,8,10,0.85)';
            ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.moveTo(n.x - r * 0.6, n.y + r * 0.6); ctx.lineTo(n.x + r * 0.6, n.y - r * 0.6); ctx.stroke();
            if (this.labels && n.count > 0) {
                ctx.font = '11px system-ui, sans-serif';
                const text = n.host.length > 26 ? `${n.host.slice(0, 25)}…` : n.host;
                const tw = ctx.measureText(text).width;
                const left = n.x < cx;
                const lx = left ? n.x - r - 6 - tw : n.x + r + 6;
                if (free(lx - 2, n.y - 8, tw + 4, 15)) {
                    ctx.fillStyle = 'rgba(230,230,236,0.78)';
                    ctx.textAlign = 'left';
                    ctx.fillText(text, lx, n.y + 3.5);
                }
            }
        }

        // Company hubs
        for (const hb of this.hubs.values()) {
            const r = 5 + Math.min(7, Math.log2(hb.count + 1) * 1.5);
            ctx.fillStyle = '#16161b';
            ctx.strokeStyle = 'rgba(255,59,69,0.75)';
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(hb.x, hb.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#ff3b45';
            ctx.beginPath(); ctx.arc(hb.x, hb.y, r * 0.38, 0, Math.PI * 2); ctx.fill();
            if (this.labels || this.hubs.size <= 6) {
                ctx.fillStyle = 'rgba(244,244,246,0.92)';
                ctx.font = `${this.labels ? 600 : 650} ${this.labels ? 12 : 9.5}px system-ui, sans-serif`;
                ctx.textAlign = 'center';
                const below = hb.y >= cy;
                ctx.fillText(hb.name, hb.x, hb.y + (below ? r + (this.labels ? 15 : 12) : -r - (this.labels ? 8 : 6)));
            }
        }

        // Center: the protected site
        const pulse = this.paused || this.reduced ? 0 : (Math.sin(time * 2.4) + 1) / 2;
        const cr = R * 0.15;
        ctx.fillStyle = `rgba(229,9,20,${0.1 + pulse * 0.08})`;
        ctx.beginPath(); ctx.arc(cx, cy, cr * (1.5 + pulse * 0.15), 0, Math.PI * 2); ctx.fill();
        shield(ctx, cx, cy, cr, this.paused ? '#5d5d68' : '#e50914');

        // Bursts for non-request events
        this.bursts = this.bursts.filter((b) => {
            b.t += 1 / 50;
            ctx.strokeStyle = hexA(b.color, 1 - b.t);
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(cx, cy, cr + b.t * R * 0.7, 0, Math.PI * 2); ctx.stroke();
            return b.t < 1;
        });
        this.floaters = this.floaters.filter((f, i) => {
            f.t += 1 / 90;
            ctx.fillStyle = hexA(f.color, Math.min(1, 2 - f.t * 2));
            ctx.font = `700 ${this.labels ? 13 : 10.5}px system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText(f.text, cx, cy - cr - 10 - f.t * 30 - i * 4);
            return f.t < 1;
        });

        // Hover tooltip (dashboard)
        if (this.mouse) {
            let best = null, bd = 14;
            for (const n of this.nodes.values()) { const d = Math.hypot(n.x - this.mouse.x, n.y - this.mouse.y); if (d < bd) { bd = d; best = n; } }
            if (best) {
                const text = `${best.host} · ${best.hub.name} · blocked ${best.count}×`;
                ctx.font = '12px system-ui, sans-serif';
                const tw = ctx.measureText(text).width + 16;
                const x = Math.min(w - tw - 4, best.x + 10), y = Math.max(4, best.y - 30);
                ctx.fillStyle = 'rgba(14,14,18,0.95)'; ctx.strokeStyle = hexA(best.color, 0.7);
                roundRect(ctx, x, y, tw, 22, 7); ctx.fill(); ctx.stroke();
                ctx.fillStyle = '#f4f4f6'; ctx.textAlign = 'left'; ctx.fillText(text, x + 8, y + 15);
            }
        }
    }

    destroy() { cancelAnimationFrame(this.raf); }
}

// Rolling "blocked per second" chart
export class LiveChart {
    constructor(canvas, { seconds = 60, color = '#e50914' } = {}) {
        this.c = canvas; this.ctx = canvas.getContext('2d'); this.color = color;
        this.buckets = new Array(seconds).fill(0);
        this.resize();
        new ResizeObserver(() => this.resize()).observe(canvas);
        this.timer = setInterval(() => { this.buckets.shift(); this.buckets.push(0); this.draw(); }, 1000);
        this.draw();
    }
    resize() {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const { width, height } = this.c.getBoundingClientRect();
        this.w = width; this.h = height;
        this.c.width = Math.max(1, width * dpr); this.c.height = Math.max(1, height * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.draw();
    }
    hit(n = 1) { this.buckets[this.buckets.length - 1] += n; this.draw(); }
    // Fill from past events ({ t } in ms) so the chart isn't flat when it opens
    seed(events) {
        const now = Date.now();
        for (const ev of events) {
            const age = Math.floor((now - ev.t) / 1000);
            if (ev.kind !== 'param' && age >= 0 && age < this.buckets.length) this.buckets[this.buckets.length - 1 - age]++;
        }
        this.draw();
    }
    rate() { return this.buckets.slice(-10).reduce((a, b) => a + b, 0) / 10; }
    draw() {
        const { ctx, w, h, buckets } = this;
        if (!w) return;
        ctx.clearRect(0, 0, w, h);
        const max = Math.max(4, ...buckets);
        const step = w / (buckets.length - 1);
        const pts = buckets.map((v, i) => [i * step, h - 2 - (v / max) * (h - 6)]);
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, hexA(this.color, 0.45)); g.addColorStop(1, hexA(this.color, 0));
        ctx.beginPath(); ctx.moveTo(0, h);
        for (const [x, y] of pts) ctx.lineTo(x, y);
        ctx.lineTo(w, h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.strokeStyle = this.color; ctx.lineWidth = 1.5; ctx.stroke();
        const [lx, ly] = pts[pts.length - 1];
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(lx - 1, ly, 2.2, 0, Math.PI * 2); ctx.fill();
    }
    destroy() { clearInterval(this.timer); }
}

// Privacy grade for what a site tried to do (everything listed here was stopped)
export function grade(s, https = true) {
    const companies = Object.keys(s?.companies || {}).length;
    let score = 100;
    score -= Math.min(30, (s?.trackers || 0) * 1.5);
    score -= Math.min(30, companies * 3);
    score -= Math.min(36, (s?.fp || 0) * 12);
    score -= Math.min(15, (s?.popups || 0) * 5);
    score -= Math.min(10, Math.max(0, (s?.ads || 0) - 5) * 0.5);
    if (!https) score -= 15;
    const letter = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';
    return { letter, score: Math.max(0, Math.round(score)), companies };
}
export const GRADE_COLORS = { A: '#22d38a', B: '#9bd34a', C: '#ffb020', D: '#ff7a33', F: '#ff3b45' };

function shield(ctx, x, y, r, color) {
    ctx.save();
    ctx.translate(x, y); ctx.scale(r / 54, r / 54); ctx.translate(-64, -64);
    ctx.fillStyle = color;
    ctx.shadowColor = color; ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(64, 10); ctx.lineTo(108, 26); ctx.lineTo(108, 62);
    ctx.bezierCurveTo(108, 90, 89, 108, 64, 118); ctx.bezierCurveTo(39, 108, 20, 90, 20, 62); ctx.lineTo(20, 26); ctx.closePath();
    ctx.fill();
    ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}
