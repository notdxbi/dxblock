#!/usr/bin/env node
// End-to-end test: loads dist/ into a clean Chromium and checks real pages.
//   node tools/test.mjs [--headed] [--baseline] [--quick] [--brave]
//     --baseline  run without the extension      --quick  install + local checks only (no internet sites)
//     --brave     use the installed Brave instead of Playwright's Chromium
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const BASELINE = process.argv.includes('--baseline');
const QUICK = process.argv.includes('--quick');
const BRAVE = process.argv.includes('--brave');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dxblock-test-'));
const results = [];
const check = (name, pass, detail = '') => {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// Local test page: generic + specific hiding, network blocking, pop-up
const PAGE = `<!doctype html><html><head><title>dx.block test</title></head><body>
<div class="sponsored-post" id="t-generic">generic .sponsored-post</div>
<div id="div-gpt-ad-123" class="x">high-generic div-gpt-ad</div>
<div id="adbox" class="ad-banner">generic #adbox</div>
<div id="t-visible" class="article">real content</div>
<script>
  window.netResults = {};
  for (const [k, u] of Object.entries({
    criteo: 'https://static.criteo.net/js/ld/publishertag.js',
    taboola: 'https://cdn.taboola.com/libtrc/test/loader.js',
    hotjar: 'https://static.hotjar.com/c/hotjar-123.js?sv=6',
    jquery: 'https://code.jquery.com/jquery-3.7.1.min.js'
  })) {
    const s = document.createElement('script');
    s.src = u;
    s.onload = () => (window.netResults[k] = 'loaded');
    s.onerror = () => (window.netResults[k] = 'blocked');
    document.head.appendChild(s);
  }
  setTimeout(() => {
    const el = document.createElement('div'); el.className = 'sponsored-post'; el.textContent = 'late ad';
    el.id = 't-late'; document.body.appendChild(el);
  }, 800);
</script>
</body></html>`;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
}).listen(0);
const port = server.address().port;

const args = BASELINE ? [] : [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`];
const ctx = await chromium.launchPersistentContext(profile, {
    ...(BRAVE ? { executablePath: process.env.BRAVE_BIN || '/opt/brave.com/brave/brave' } : { channel: 'chromium' }),
    headless: !process.argv.includes('--headed'),
    args: [...args, '--no-first-run', '--disable-features=DisableLoadExtensionCommandLineSwitch'],
    viewport: { width: 1280, height: 900 }
});

let sw = null;
if (!BASELINE) {
    sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    // Wait for setup (rulesets + registered scripts)
    let state;
    for (let i = 0; i < 60; i++) {
        state = await sw.evaluate(async () => ({
            rulesets: (await chrome.declarativeNetRequest.getEnabledRulesets()).length,
            scripts: (await chrome.scripting.getRegisteredContentScripts()).length,
            dynamic: (await chrome.declarativeNetRequest.getDynamicRules()).length,
            available: await chrome.declarativeNetRequest.getAvailableStaticRuleCount()
        }));
        const ready = await sw.evaluate(async () => (await chrome.storage.session.get('ready')).ready);
        if (ready) break;
        await new Promise((r) => setTimeout(r, 500));
    }
    check('extension initialised', state.rulesets >= 10 && state.scripts > 50,
        `${state.rulesets} rulesets, ${state.scripts} content scripts, ${state.available} static rules spare`);
    // Close the options tab opened on install
    for (const p of ctx.pages()) if (p.url().startsWith('chrome-extension://')) await p.close();
}

const page = await ctx.newPage();

// 1. Local page
await page.goto(`http://localhost:${port}/`);
await page.waitForTimeout(2500);
const local = await page.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); return e && getComputedStyle(e).display !== 'none'; };
    return {
        generic: vis('t-generic'), gpt: vis('div-gpt-ad-123'), late: vis('t-late'), content: vis('t-visible'),
        banner: getComputedStyle(document.querySelector('.ad-banner')).display !== 'none',
        net: window.netResults
    };
});
check('generic hiding (.sponsored-post)', BASELINE ? local.generic : !local.generic);
check('generic hiding (#adbox)', BASELINE ? local.banner : !local.banner);
check('high-generic hiding (div-gpt-ad)', BASELINE ? local.gpt : !local.gpt);
check('late-inserted ad hidden', BASELINE ? local.late : !local.late);
check('real content still visible', local.content);
check('criteo blocked', BASELINE || local.net.criteo === 'blocked', local.net.criteo);
check('taboola blocked', BASELINE || local.net.taboola === 'blocked', local.net.taboola);
check('hotjar blocked', BASELINE || local.net.hotjar === 'blocked', local.net.hotjar);
if (sw) {
    // Requests that are blocked or swapped for a harmless stand-in (uBO "surrogates")
    const handled = await sw.evaluate(async (urls) => {
        const out = {};
        for (const [u, type] of urls) {
            const m = (await chrome.declarativeNetRequest.testMatchOutcome({ url: u, type, initiator: 'https://news.example', tabId: -1 })).matchedRules;
            out[u] = m.length ? m.map((r) => r.rulesetId).join(',') : null;
        }
        return out;
    }, [
        ['https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'script'],
        ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'script'],
        ['https://www.google-analytics.com/analytics.js', 'script'],
        ['https://ad.doubleclick.net/ddm/trackclk/N1234.5678/B123;dc_trk_aid=1', 'sub_frame'],
        ['https://connect.facebook.net/en_US/fbevents.js', 'script'],
        ['https://bat.bing.com/bat.js', 'script'],
        ['https://cdn.amplitude.com/libs/amplitude-8.21.9-min.gz.js', 'script'],
        ['https://c.amazon-adsystem.com/aax2/apstag.js', 'script'],
        ['https://ib.adnxs.com/ut/v3/prebid', 'xmlhttprequest'],
        ['https://example.com/?fbclid=1&utm_source=x', 'main_frame']
    ]);
    for (const [u, r] of Object.entries(handled)) check(`handled: ${u.replace(/^https:\/\//, '').slice(0, 60)}`, !!r, r || 'no rule');
}
check('jquery (not an ad) loads', local.net.jquery === 'loaded', local.net.jquery);

if (QUICK) {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed (quick)`);
    await ctx.close(); server.close(); fs.rmSync(profile, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
}

// 2. Public ad-block test page (adblock.turtlecute.org). Note: like uBlock Origin, some ad requests are
//    answered with a harmless empty response instead of an error (defeats ad-block detection), which this
//    test counts as "not blocked".
try {
    await page.goto('https://adblock.turtlecute.org/', { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(15000);
    const r = await page.evaluate(() => {
        const t = document.body.innerText;
        const total = Number(/Total\s*:\s*(\d+)/.exec(t)?.[1]);
        const blocked = Number(/(\d+)\s*blocked/.exec(t)?.[1]);
        return { total, blocked };
    });
    check('turtlecute ad-block test', BASELINE ? true : r.blocked === r.total, `${r.blocked}/${r.total} blocked`);
} catch (e) {
    check('turtlecute ad-block test', false, e.message.split('\n')[0]);
}

// 2b. superadblocktest.com (482 ad / tracker / telemetry host probes)
try {
    await page.goto('https://superadblocktest.com/', { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.getByRole('button', { name: /start test/i }).first().click({ timeout: 8000 })
        .catch(() => page.locator('text=/start test/i').first().click({ timeout: 8000 }));
    await page.waitForTimeout(40000);
    const txt = await page.evaluate(() => document.body.innerText);
    const score = Number(/PROTECTION SCORE\s*(\d+)%/i.exec(txt)?.[1]);
    const raw = Number(/RAW BLOCK RATE\s*(\d+)%/i.exec(txt)?.[1]);
    check('superadblocktest.com score', BASELINE ? true : score === 100, `protection ${score}%, raw ${raw}%`);
} catch (e) {
    check('superadblocktest.com score', false, e.message.split('\n')[0]);
}

// 3. URL tracking parameters stripped
try {
    await page.goto('https://example.com/?gclid=test&fbclid=abc&keep=1', { timeout: 30000 });
    const u = page.url();
    check('tracking params removed', BASELINE || (!/gclid|fbclid/.test(u) && /keep=1/.test(u)), u);
} catch (e) {
    check('tracking params removed', false, e.message.split('\n')[0]);
}

// 4. YouTube: ad data pruned from the player response
try {
    await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(6000);
    const yt = await page.evaluate(() => {
        const r = window.ytInitialPlayerResponse;
        return { hasResponse: !!r, adPlacements: r ? Array.isArray(r.adPlacements) && r.adPlacements.length : null, playerAds: r ? !!r.playerAds : null };
    });
    check('YouTube ad placements removed', BASELINE || (yt.hasResponse && !yt.adPlacements && !yt.playerAds), JSON.stringify(yt));
} catch (e) {
    check('YouTube ad placements removed', false, e.message.split('\n')[0]);
}

// 5. Features: pop-up blocker, site toggle, user filters, element picker
if (sw) {
    const extId = new URL(sw.url()).host;
    const ext = await ctx.newPage();
    await ext.goto(`chrome-extension://${extId}/options/options.html`);
    const msg = (m) => ext.evaluate((x) => chrome.runtime.sendMessage(x), m);

    // Blocked counter + badge
    await page.goto(`http://localhost:${port}/`);
    await page.waitForTimeout(2500);
    const pageTab = await ext.evaluate(async () => (await chrome.tabs.query({ url: 'http://localhost/*' }))[0]?.id);
    const st = await msg({ type: 'popup:state', tabId: pageTab });
    const badge = await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), pageTab);
    check('blocked counter counts requests', st.stats.blocked >= 3, `blocked ${st.stats.blocked} (ads ${st.stats.ads}, trackers ${st.stats.trackers}), feed ${st.recent.length}`);
    check('toolbar badge shows the count', Number(badge) === st.stats.blocked, `badge "${badge}"`);
    const hiddenN = await msg({ type: 'popup:hidden', tabId: pageTab });
    check('elements hidden counted', hiddenN >= 3, `${hiddenN}`);

    // Dangerous page -> warning page
    await page.goto('https://vlc.de/', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    check('dangerous page shows dx.block warning', page.url().includes('/blocked/blocked.html'), page.url().slice(0, 90));

    // Pop-up blocker
    await page.goto(`http://localhost:${port}/`);
    const before = ctx.pages().length;
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<button id="pop" onclick="window.open(\'http://11x11.com/\')">pop</button>'); });
    await page.click('#pop');
    await page.waitForTimeout(2500);
    check('pop-up to ad domain closed', ctx.pages().length === before, `${ctx.pages().length - before} extra tab(s)`);
    for (const p of ctx.pages()) if (p.url().includes('11x11')) await p.close();

    // User filters
    const saved = await msg({ type: 'options:save-filters', text: 'localhost##.article\n||code.jquery.com^\n' });
    check('user filters compile', saved.ok === 2 && !saved.errors.length, JSON.stringify(saved));
    await page.goto(`http://localhost:${port}/`);
    await page.waitForTimeout(2000);
    const uf = await page.evaluate(() => ({ hidden: getComputedStyle(document.getElementById('t-visible')).display === 'none', jq: window.netResults.jquery }));
    check('user cosmetic filter hides element', uf.hidden);
    check('user network filter blocks request', uf.jq === 'blocked', uf.jq);
    await msg({ type: 'options:save-filters', text: '' });

    // Site toggle (allowlist)
    await msg({ type: 'site:toggle', host: 'localhost', disabled: true });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForTimeout(2500);
    const off = await page.evaluate(() => ({ ad: getComputedStyle(document.getElementById('adbox')).display !== 'none', criteo: window.netResults.criteo }));
    check('allowlisted site: ads shown', off.ad && off.criteo === 'loaded', JSON.stringify(off));
    await msg({ type: 'site:toggle', host: 'localhost', disabled: false });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForTimeout(2500);
    const on = await page.evaluate(() => ({ ad: getComputedStyle(document.getElementById('adbox')).display !== 'none', criteo: window.netResults.criteo }));
    check('re-enabled site: ads blocked again', !on.ad && on.criteo === 'blocked', JSON.stringify(on));

    // Element picker
    const tabId = await ext.evaluate(async () => (await chrome.tabs.query({ url: 'http://localhost/*' }))[0]?.id);
    await page.bringToFront();
    await msg({ type: 'picker:start', tabId });
    await page.waitForTimeout(500);
    const box = await page.locator('#t-visible').boundingBox();
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.click(box.x + 5, box.y + 5);
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    const picked = await msg({ type: 'options:get' });
    check('element picker creates a filter', /localhost##/.test(picked.userFilters), picked.userFilters.trim());
    await msg({ type: 'options:save-filters', text: '' });

    // UI screenshots for a visual check
    await ext.setViewportSize({ width: 1000, height: 1100 });
    await ext.reload();
    await ext.waitForTimeout(800);
    await ext.screenshot({ path: path.join(os.tmpdir(), 'dxblock-options.png') });
    await page.goto('https://adblock.turtlecute.org/', { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(6000);
    const liveTab = await ext.evaluate(async () => (await chrome.tabs.query({ url: 'https://adblock.turtlecute.org/*' }))[0]?.id);
    const pop = await ctx.newPage();
    await pop.setViewportSize({ width: 360, height: 640 });
    await pop.goto(`chrome-extension://${extId}/popup/popup.html?tab=${liveTab}`);
    await pop.waitForTimeout(1600);
    await pop.screenshot({ path: path.join(os.tmpdir(), 'dxblock-popup.png') });
    const banners = await pop.evaluate(() => ({ access: getComputedStyle(document.getElementById('access')).display, update: getComputedStyle(document.getElementById('update')).display, power: document.getElementById('power').checked }));
    check('popup: no stray banners, protection shown on', banners.access === 'none' && banners.update === 'none' && banners.power, JSON.stringify(banners));
    await pop.close();
    await ext.close();
}

if (sw) {
    const errs = await sw.evaluate(() => self.__dxbErrors || []);
    if (errs.length) console.log('service worker errors:', errs);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed${BASELINE ? ' (baseline, no extension)' : ''}`);
await ctx.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
