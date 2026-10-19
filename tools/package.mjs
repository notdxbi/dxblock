#!/usr/bin/env node
// Zips dist/ (Chrome, Brave, Edge, Opera, Vivaldi) and dist-firefox/ for the browser stores.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'manifest.json'), 'utf8'));
for (const [dir, name] of [['dist', `dxblock-${version}-chromium.zip`], ['dist-firefox', `dxblock-${version}-firefox.zip`]]) {
    const out = path.join(ROOT, name);
    fs.rmSync(out, { force: true });
    execFileSync('zip', ['-qr9X', out, '.'], { cwd: path.join(ROOT, dir), stdio: 'inherit' });
    console.log(`:: ${name} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
}

// Firefox Add-ons (AMO) listing: Mozilla delivers updates itself, so no update_url
{
    const amoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxblock-amo-'));
    fs.cpSync(path.join(ROOT, 'dist-firefox'), amoDir, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(amoDir, 'manifest.json'), 'utf8'));
    delete m.browser_specific_settings.gecko.update_url;
    fs.writeFileSync(path.join(amoDir, 'manifest.json'), JSON.stringify(m, null, 2));
    const out = path.join(ROOT, `dxblock-${version}-firefox-amo.zip`);
    fs.rmSync(out, { force: true });
    execFileSync('zip', ['-qr9X', out, '.'], { cwd: amoDir, stdio: 'inherit' });
    fs.rmSync(amoDir, { recursive: true, force: true });
    console.log(`:: ${path.basename(out)} (for addons.mozilla.org)`);
}
// Source code for store reviewers (generated files are rebuilt from this with "npm ci && npm run build")
{
    const out = path.join(ROOT, `dxblock-${version}-source.zip`);
    fs.rmSync(out, { force: true });
    execFileSync('git', ['archive', '--format=zip', '-o', out, 'HEAD'], { cwd: ROOT, stdio: 'inherit' });
    console.log(`:: ${path.basename(out)} (source for reviewers)`);
}
