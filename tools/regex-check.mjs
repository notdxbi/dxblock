// Asks Chrome itself which regexFilter values it can compile (chrome.declarativeNetRequest.isRegexSupported).
// Chrome silently skips a regex rule whose compiled program is over its 2 KB memory limit and shows a
// warning for each one on chrome://extensions, so dx.block drops those at build time instead.
// Answers are cached in tools/regex-cache.json, so only new or changed regexes start a browser.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'regex-cache.json');

const key = (regex, caseSensitive) => `${caseSensitive ? 'cs' : 'ci'}\u0000${regex}`;

function readCache() {
    try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; }
}

// items: [{ regex, caseSensitive }] → Map(key → true/false). Returns null when no browser is available
// (the build then keeps its own heuristic check only).
export async function checkRegexes(items) {
    const cache = readCache();
    const todo = [...new Map(items.filter((i) => !(key(i.regex, i.caseSensitive) in cache)).map((i) => [key(i.regex, i.caseSensitive), i])).values()];
    if (todo.length) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxblock-regex-'));
        const ext = path.join(dir, 'ext');
        fs.mkdirSync(ext);
        fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({
            manifest_version: 3, name: 'regex check', version: '1', permissions: ['declarativeNetRequest'],
            background: { service_worker: 'sw.js' },
        }));
        fs.writeFileSync(path.join(ext, 'sw.js'), '// helper for tools/regex-check.mjs\n');
        let ctx;
        try {
            // full Chromium (channel), not the headless shell: the shell can't load extensions
            ctx = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
                channel: 'chromium',
                headless: true,
                args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run', '--disable-features=DisableLoadExtensionCommandLineSwitch'],
            });
            const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
            const answers = await sw.evaluate(async (list) => Promise.all(list.map((i) =>
                chrome.declarativeNetRequest.isRegexSupported({ regex: i.regex, isCaseSensitive: i.caseSensitive, requireCapturing: false })
                    .then((r) => !!r.isSupported).catch(() => false))), todo);
            todo.forEach((i, n) => { cache[key(i.regex, i.caseSensitive)] = answers[n]; });
            fs.writeFileSync(CACHE, JSON.stringify(cache, null, 0));
        } catch (err) {
            console.warn(`regex check skipped (no Chromium for Playwright?): ${err.message.split('\n')[0]}`);
            return null;
        } finally {
            if (ctx) await ctx.close().catch(() => {});
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    return new Map(items.map((i) => [key(i.regex, i.caseSensitive), cache[key(i.regex, i.caseSensitive)] !== false]));
}

export { key as regexKey };
