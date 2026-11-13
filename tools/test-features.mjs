#!/usr/bin/env node
// Checks for the 1.4 features on local pages (plus a few real sites unless --offline):
// screen-recording alert, cookie "Reject all", dark patterns, clipboard guard, lockdown, unlock copy,
// clean links, site grades, breach list, Shorts redirect.
//   node tools/test-features.mjs [--headed] [--offline]
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OFFLINE = process.argv.includes('--offline');
const results = [];
const check = (name, pass, detail = '') => {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const PAGES = {
    '/replay': `<!doctype html><title>replay</title><p>hello</p>
        <script src="https://www.clarity.ms/tag/abcdef123"></script><script src="https://static.hotjar.com/c/hotjar-1.js?sv=6"></script>`,
    '/consent': `<!doctype html><title>consent</title>
        <div id="onetrust-banner-sdk"><p>We use cookies</p><button id="onetrust-accept-btn-handler">Accept all</button>
        <button id="onetrust-reject-all-handler" onclick="window.rejected='known'">Reject All</button></div>`,
    '/consent2': `<!doctype html><title>consent2</title><p>article</p>
        <div class="my-cookie-notice" style="position:fixed;bottom:0">We use cookies and similar tracking to improve your experience.
        <button onclick="window.rejected='wrong'">Accept all</button><button onclick="window.rejected='generic'">Reject all</button></div>`,
    '/dark': `<!doctype html><title>dark</title><body style="font:16px sans-serif">
        <div class="stock">Only 2 left in stock</div>
        <div class="viewers">14 people are viewing this right now</div>
        <div class="deal">Offer ends in <span id="clock">09:59</span></div>
        <form><label><input type="checkbox" checked> Send me marketing offers and newsletters</label></form>
        <a href="#">No thanks, I don't want to save money</a>
        <p class="normal">Free delivery on orders over £20.</p>
        <script>let n = 599; setInterval(() => { n--; document.getElementById('clock').textContent = '0' + Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0'); }, 500);</script></body>`,
    '/clip': `<!doctype html><title>clip</title><p id="t">The quick brown fox jumps over the lazy dog</p><p id="w">bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh</p>
        <script>
          document.addEventListener('copy', (e) => {
            const sel = String(getSelection());
            const swap = sel.startsWith('bc1');
            e.clipboardData.setData('text/plain', swap ? 'bc1qATTACKERattackerattackerattacker0000000' : sel + '\\n\\nRead more at https://example.com/article/123456');
            e.preventDefault();
          });
          document.addEventListener('copy', (e) => { window.copied = e.clipboardData.getData('text/plain'); });
          setTimeout(() => navigator.clipboard.writeText('silent').then(() => (window.silent = 'written'), (err) => (window.silent = err.name)), 6500);
        </script>`,
    '/lock': `<!doctype html><title>lock</title><p>locked page</p><script>window.ran = 1;</script>`,
    '/nocopy': `<!doctype html><title>nocopy</title><p id="p" style="user-select:none">Can't copy me</p>
        <script>document.addEventListener('contextmenu', (e) => e.preventDefault()); document.addEventListener('copy', (e) => e.preventDefault());</script>`
};
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGES[new URL(req.url, 'http://x').pathname] || '<!doctype html><title>ok</title><p>ok</p>');
}).listen(0);
const BASE = `http://localhost:${server.address().port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dxblock-feat-'));
const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: !process.argv.includes('--headed'),
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--disable-features=DisableLoadExtensionCommandLineSwitch'],
    viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write']
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
for (let i = 0; i < 80; i++) {
    if (await sw.evaluate(async () => (await chrome.storage.session.get('ready')).ready)) break;
    await new Promise((r) => setTimeout(r, 500));
}
const extId = new URL(sw.url()).host;
for (const p of ctx.pages()) if (p.url().startsWith('chrome-extension://')) await p.close();
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/options/options.html`);
const msg = (m) => ext.evaluate((m) => chrome.runtime.sendMessage(m), m);
const tabIdOf = (url) => ext.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, url);

const page = await ctx.newPage();

// Screen recording
await page.goto(`${BASE}/replay`);
await page.waitForTimeout(2000);
let st = await msg({ type: 'popup:state', tabId: await tabIdOf(`${BASE}/replay`) });
check('screen recording detected and named', st.stats.replayBy?.length >= 1, (st.stats.replayBy || []).join(', '));
check('screen recording lowers the grade', st.stats.replay >= 1);

// Cookie banners
await page.goto(`${BASE}/consent`);
await page.waitForTimeout(1500);
check('cookie banner: known tool gets "Reject all"', await page.evaluate(() => window.rejected) === 'known', await page.evaluate(() => String(window.rejected)));
await page.goto(`${BASE}/consent2`);
await page.waitForTimeout(1500);
check('cookie banner: generic banner gets "Reject all"', await page.evaluate(() => window.rejected) === 'generic', await page.evaluate(() => String(window.rejected)));

// Dark patterns
await page.goto(`${BASE}/dark`);
await page.waitForTimeout(5000);
const dark = await page.evaluate(() => [...document.querySelectorAll('[data-dxb-dark]')].map((e) => e.getAttribute('data-dxb-dark')));
check('dark patterns: scarcity, social proof, countdown, guilt-trip, pre-ticked', ['scarcity', 'social', 'countdown', 'shame', 'pretick'].every((k) => dark.includes(k)), dark.join(', '));
check('dark patterns: normal text left alone', await page.evaluate(() => !document.querySelector('.normal[data-dxb-dark]')));
st = await msg({ type: 'popup:state', tabId: await tabIdOf(`${BASE}/dark`) });
check('dark patterns listed in the popup', st.stats.darkKinds?.length >= 4, `${st.stats.darkKinds?.length}`);

// Clipboard
await page.goto(`${BASE}/clip`);
await page.waitForTimeout(300);
const copyOf = async (id) => {
    await page.evaluate((id) => { const r = document.createRange(); r.selectNodeContents(document.getElementById(id)); getSelection().removeAllRanges(); getSelection().addRange(r); }, id);
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(300);
    return page.evaluate(() => window.copied);
};
const c1 = await copyOf('t');
check('clipboard: "Read more at" tail removed', c1 === 'The quick brown fox jumps over the lazy dog', JSON.stringify(c1));
const c2 = await copyOf('w');
check('clipboard: wallet address swap stopped', c2 === 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', JSON.stringify(c2));
await page.waitForTimeout(6800);
check('clipboard: silent write without a click blocked', await page.evaluate(() => window.silent) === 'NotAllowedError', await page.evaluate(() => String(window.silent)));
check('clipboard: notice shown', await page.evaluate(() => !!document.querySelector('dxblock-toast')));

// Unlock copy
await page.goto(`${BASE}/nocopy`);
await page.waitForTimeout(300);
const blockedBefore = await page.evaluate(() => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); document.getElementById('p').dispatchEvent(e); return e.defaultPrevented; });
await msg({ type: 'site:unlock', tabId: await tabIdOf(`${BASE}/nocopy`) });
const after = await page.evaluate(() => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); document.getElementById('p').dispatchEvent(e);
    return { prevented: e.defaultPrevented, select: getComputedStyle(document.getElementById('p')).userSelect };
});
check('unlock copy: right-click and selection work again', blockedBefore && !after.prevented && after.select !== 'none', JSON.stringify(after));

// Lockdown
await page.goto(`${BASE}/lock`);
check('lockdown: scripts run normally first', await page.evaluate(() => window.ran) === 1);
await msg({ type: 'site:lock', host: 'localhost', on: true });
await page.reload();
await page.waitForTimeout(500);
check('lockdown: inline scripts blocked', await page.evaluate(() => window.ran) === undefined);
await msg({ type: 'site:lock', host: 'localhost', on: false });
await page.reload();
check('lockdown off again', await page.evaluate(() => window.ran) === 1);

// Clean links
const c = await msg({ type: 'link:clean', url: 'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fpage%3Fid%3D5%26utm_source%3Dx%26fbclid%3Dabc&sa=D' });
check('clean link: Google redirect + trackers removed', c === 'https://example.com/page?id=5', c);
const a = await msg({ type: 'link:clean', url: 'https://www.amazon.co.uk/Some-Thing/dp/B0ABCDEFGH/ref=sr_1_1?keywords=x&qid=17000&sr=8-1' });
check('clean link: Amazon product shortened', a === 'https://www.amazon.co.uk/dp/B0ABCDEFGH', a);
const y = await msg({ type: 'link:clean', url: 'https://youtu.be/abc?si=XYZ&t=42' });
check('clean link: YouTube share tracker gone, timestamp kept', y === 'https://youtu.be/abc?t=42', y);

// Site grades (remembered for search badges)
await page.goto(`${BASE}/replay`);
await page.waitForTimeout(4500);
await page.goto(`${BASE}/other`);
await page.waitForTimeout(2500);
const g = await msg({ type: 'grades:get', hosts: ['localhost'] });
check('site grade remembered for search badges', !!g.localhost?.grade?.letter, JSON.stringify(g.localhost?.grade || null));

if (!OFFLINE) {
    const list = await msg({ type: 'breach:list' });
    check('breach list downloaded', list.list?.length > 500, `${list.list?.length} breaches`);
    const b = await msg({ type: 'grades:get', hosts: ['adobe.com', 'www.linkedin.com'] });
    check('breach chip data for known breached sites', !!b['adobe.com']?.breach && !!b['www.linkedin.com']?.breach, `${b['adobe.com']?.breach?.title}, ${b['www.linkedin.com']?.breach?.title}`);

    await msg({ type: 'tweaks:set', tweaks: { hideShorts: true } });
    await page.goto('https://www.youtube.com/shorts/aqz-KE-bpKQ').catch(() => {});
    check('Shorts link opens as a normal video', /youtube\.com\/watch\?v=aqz-KE-bpKQ/.test(page.url()), page.url());

}

// Search badges (a stand-in results page served at DuckDuckGo's address: the real one asks headless browsers for a captcha)
await ctx.route('https://duckduckgo.com/**', (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><title>results</title>
    <article><h2><a data-testid="result-title-a" href="${BASE}/x">Local result</a></h2></article>
    <article><h2><a data-testid="result-title-a" href="https://adobe.com/">Adobe</a></h2></article>
    <article><h2><a data-testid="result-title-a" href="https://never-visited.example/">Other</a></h2></article>` }));
await page.goto('https://duckduckgo.com/?q=test');
await page.waitForTimeout(2000);
const badges = await page.evaluate(() => [...document.querySelectorAll('a[data-testid="result-title-a"]')].map((a) => a.querySelectorAll('dxblock-badge').length));
check('search badge: grade shown for a visited site', badges[0] === 1, JSON.stringify(badges));
if (!OFFLINE) check('search badge: breach chip for a breached site', badges[1] === 1);
check('search badge: nothing for unknown sites', badges[2] === 0);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await ctx.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
