#!/usr/bin/env node
// Firefox smoke test: installs dist-firefox/ as a temporary add-on in a real (headless) Firefox and checks
// blocking, hiding, counters and the settings page.   node tools/test-firefox.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { download } from 'geckodriver';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'dist-firefox');
const UUID = 'd7b10c4e-5a3f-4f8e-9e7b-6d2c1a9f0b11';
const results = [];
const check = (name, pass, detail = '') => {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// Test copy with a localhost-only bridge (Marionette can't script extension pages)
const COPY = fs.mkdtempSync(path.join(os.tmpdir(), 'dxblock-ff-'));
fs.cpSync(SRC, COPY, { recursive: true });
fs.writeFileSync(path.join(COPY, 'test-bridge.js'), `window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data?.dxbTest) return;
  chrome.runtime.sendMessage(e.data.msg).then((r) => window.postMessage({ dxbTestReply: e.data.id, r }, '*'), (err) => window.postMessage({ dxbTestReply: e.data.id, r: { error: String(err) } }, '*'));
});`);
const man = JSON.parse(fs.readFileSync(path.join(COPY, 'manifest.json')));
man.content_scripts.push({ matches: ['http://localhost/*'], js: ['test-bridge.js'], run_at: 'document_start' });
fs.writeFileSync(path.join(COPY, 'manifest.json'), JSON.stringify(man));
fs.appendFileSync(path.join(COPY, 'background.js'), `\nchrome.runtime.onMessage.addListener((m, s, reply) => { if (m?.type !== '__tabs') return false; chrome.tabs.query({}).then(reply); return true; });\n`);
const xpi = path.join(os.tmpdir(), 'dxblock-test.xpi');
fs.rmSync(xpi, { force: true });
execFileSync('zip', ['-qr9X', xpi, '.'], { cwd: COPY });

const PAGE = `<!doctype html><html><body>
<div class="sponsored-post" id="t-generic">generic</div><div id="div-gpt-ad-1">gpt</div><div id="t-visible">content</div>
<script>window.netResults={};for(const[k,u]of Object.entries({criteo:'https://static.criteo.net/js/ld/publishertag.js',taboola:'https://cdn.taboola.com/libtrc/test/loader.js',jquery:'https://code.jquery.com/jquery-3.7.1.min.js'})){const s=document.createElement('script');s.src=u;s.onload=()=>netResults[k]='loaded';s.onerror=()=>netResults[k]='blocked';document.head.appendChild(s);}</script>
</body></html>`;
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE); }).listen(0);
const port = server.address().port;

const binary = await download();
const opts = new firefox.Options().addArguments('-headless')
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ 'dxblock@notdxbi': UUID }))
    .setPreference('xpinstall.signatures.required', false);
const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts)
    .setFirefoxService(new firefox.ServiceBuilder(binary)).build();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
    await driver.installAddon(xpi, true);
    await driver.get(`http://localhost:${port}/`);
    const ask = (msg) => driver.executeAsyncScript(`const done = arguments[arguments.length - 1]; const id = Math.random();
        const on = (e) => { if (e.data?.dxbTestReply === id) { removeEventListener('message', on); done(e.data.r); } };
        addEventListener('message', on); postMessage({ dxbTest: 1, id, msg: arguments[0] }, '*'); setTimeout(() => done({ error: 'timeout' }), 8000);`, msg);
    let diag;
    for (let i = 0; i < 60; i++) {
        diag = await ask({ type: 'diagnostics' });
        if (diag?.contentScripts > 0) break;
        await sleep(1000);
        await driver.navigate().refresh();
    }
    check('extension initialised', diag?.rulesets >= 10 && diag?.contentScripts > 0, `${diag?.rulesets} rulesets, ${diag?.contentScripts} scripts, access ${diag?.hostAccess}, errors ${JSON.stringify(diag?.errors || []).slice(0, 300)}`);
    const welcome = [];
    for (const h of await driver.getAllWindowHandles()) { await driver.switchTo().window(h); welcome.push(await driver.getCurrentUrl()); }
    check('welcome page opens on install', welcome.some((u) => u.includes('/welcome/welcome.html')));
    await driver.switchTo().window((await driver.getAllWindowHandles())[0]);

    await driver.switchTo().newWindow('tab');
    await driver.get(`http://localhost:${port}/`);
    await sleep(3000);
    const local = await driver.executeScript(`const vis = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
        return { generic: vis('t-generic'), gpt: vis('div-gpt-ad-1'), content: vis('t-visible'), net: window.netResults };`);
    check('generic hiding', !local.generic);
    check('high-generic hiding', !local.gpt);
    check('content visible', local.content);
    check('criteo blocked', local.net.criteo === 'blocked', local.net.criteo);
    check('taboola blocked', local.net.taboola === 'blocked', local.net.taboola);
    check('jquery loads', local.net.jquery === 'loaded', local.net.jquery);

    await driver.get('https://adblock.turtlecute.org/');
    await sleep(15000);
    const tc = await driver.executeScript(`const t = document.body.innerText; return { total: +(/Total\\s*:\\s*(\\d+)/.exec(t)||[])[1], blocked: +(/(\\d+)\\s*blocked/.exec(t)||[])[1] };`);
    check('turtlecute ad-block test', tc.blocked >= tc.total - 2, `${tc.blocked}/${tc.total}`);

    // Counters, via the extension page
    const tcHandle = await driver.getWindowHandle();
    await driver.switchTo().newWindow('tab');
    await driver.get(`http://localhost:${port}/`);
    await sleep(1500);
    const tabs = await ask({ type: '__tabs' });
    const st = await ask({ type: 'popup:state', tabId: tabs?.find?.((t) => t.url.includes('turtlecute'))?.id });
    check('blocked counter works', st?.stats?.blocked > 20, `blocked ${st?.stats?.blocked}, trackers ${st?.stats?.trackers}, feed ${st?.recent?.length}`);
    console.log('limits:', JSON.stringify((await ask({ type: 'diagnostics' })).limits));
    console.log('request errors seen:', JSON.stringify((await ask({ type: 'diagnostics' })).requestErrors));
    const tweak = await ask({ type: 'diagnostics' });
    check('WebRTC leak protection applied', tweak.webrtc === 'disable_non_proxied_udp', String(tweak.webrtc));
} finally {
    await driver.quit();
    server.close();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed (Firefox)`);
process.exit(failed.length ? 1 : 0);
