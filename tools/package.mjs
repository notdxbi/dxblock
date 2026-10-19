#!/usr/bin/env node
// Zips dist/ (Chrome, Brave, Edge, Opera, Vivaldi) and dist-firefox/ for the browser stores.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
