#!/usr/bin/env node
// Zips dist/ into dxblock-<version>.zip, ready for the Chrome Web Store (which Brave uses).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'manifest.json'), 'utf8'));
const out = path.join(ROOT, `dxblock-${version}.zip`);
fs.rmSync(out, { force: true });
execFileSync('zip', ['-qr9X', out, '.'], { cwd: path.join(ROOT, 'dist'), stdio: 'inherit' });
console.log(`:: ${path.basename(out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
