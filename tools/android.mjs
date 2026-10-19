#!/usr/bin/env node
// Builds the Samsung Internet app (android/) into dxblock-samsung.apk with the plain
// Android SDK tools: no Gradle. Needs ANDROID_HOME (default ~/Android/Sdk) with build-tools and
// a platform, plus a JDK (JAVA_HOME or javac on PATH).
//   node tools/android.mjs            fetch lists, build, sign
//   node tools/android.mjs --offline  reuse the lists from the last build
// Signing key: ~/.config/dxblock/android-release.jks (created on first run; BACK IT UP: Android only
// installs updates signed with the same key). Override with DXBLOCK_KEYSTORE / DXBLOCK_KEYSTORE_PASS.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LISTS } from './lists.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'android');
const OUT = path.join(ROOT, '.cache', 'android');
const OFFLINE = process.argv.includes('--offline');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const MIN_SDK = 26, TARGET_SDK = 35;

// Lists the Samsung engine gets nothing from (AdGuard URL tracking is all $removeparam), and big
// ones left for the user to switch on (Samsung doesn't document how many rules it handles well)
const SKIP = new Set(['adguard-url-tracking']);
const OFF = new Set(['hagezi-pro', 'phishing']);

const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Android', 'Sdk');
const latest = (dir) => fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
const BT = path.join(SDK, 'build-tools', latest(path.join(SDK, 'build-tools')));
const ANDROID_JAR = path.join(SDK, 'platforms', latest(path.join(SDK, 'platforms')), 'android.jar');
const jdkTool = (name) => {
    for (const home of [process.env.JAVA_HOME, '/usr/lib/jvm/java-21-openjdk', '/usr/lib/jvm/java-17-openjdk', '/usr/lib/jvm/java-11-graalvm']) {
        if (home && fs.existsSync(path.join(home, 'bin', name))) return path.join(home, 'bin', name);
    }
    return name;
};
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const log = (s) => console.log(`:: ${s}`);

// 1. Lists: the app's switch list, and the default-on lists bundled for offline first use
const assets = path.join(OUT, 'assets');
fs.mkdirSync(assets, { recursive: true });
const raw = 'https://raw.githubusercontent.com/notdxbi/dxblock/main/';
fs.writeFileSync(path.join(assets, 'lists.tsv'), LISTS.filter((l) => !SKIP.has(l.id)).map((l) =>
    [l.id, l.on && !OFF.has(l.id) ? 1 : 0, l.name, l.desc.replace(/\s+/g, ' '), l.url.replace('local:', raw)].join('\t')).join('\n') + '\n');

const classes = path.join(OUT, 'classes');
fs.rmSync(classes, { recursive: true, force: true });
fs.mkdirSync(classes, { recursive: true });
if (!OFFLINE || !fs.existsSync(path.join(assets, 'lists'))) {
    log('Downloading filter lists');
    fs.rmSync(path.join(assets, 'lists'), { recursive: true, force: true });
    const host = path.join(OUT, 'host');
    run(jdkTool('javac'), ['-nowarn', '-d', host, path.join(APP, 'src/bi/dx/dxblock/Filters.java')]);
    run(jdkTool('java'), ['-cp', host, 'bi.dx.dxblock.Filters', path.join(assets, 'lists.tsv'), assets, path.join(OUT, 'filters-preview.txt')]);
}

// 2. Resources + manifest
log('Linking resources');
const vc = version.split('.').reduce((n, p) => n * 100 + Number(p), 0);
const flat = path.join(OUT, 'res.zip'), gen = path.join(OUT, 'gen'), base = path.join(OUT, 'base.apk');
fs.rmSync(gen, { recursive: true, force: true });
run(path.join(BT, 'aapt2'), ['compile', '--dir', path.join(APP, 'res'), '-o', flat]);
run(path.join(BT, 'aapt2'), ['link', '-o', base, '-I', ANDROID_JAR, '--manifest', path.join(APP, 'AndroidManifest.xml'),
    '--min-sdk-version', String(MIN_SDK), '--target-sdk-version', String(TARGET_SDK),
    '--version-code', String(vc), '--version-name', version, '-A', assets, '--java', gen, flat]);

// 3. Code
log('Compiling');
const sources = [...fs.readdirSync(path.join(APP, 'src/bi/dx/dxblock')).map((f) => path.join(APP, 'src/bi/dx/dxblock', f)),
    path.join(gen, 'bi/dx/dxblock/R.java')];
run(jdkTool('javac'), ['-nowarn', '-Xlint:-options', '-source', '8', '-target', '8', '-bootclasspath', `${ANDROID_JAR}${path.delimiter}${path.join(BT, 'core-lambda-stubs.jar')}`, '-d', classes, ...sources]);
const classFiles = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => e.isDirectory() ? walk(path.join(d, e.name)) : classFiles.push(path.join(d, e.name)));
walk(classes);
const dex = path.join(OUT, 'dex');
fs.rmSync(dex, { recursive: true, force: true });
fs.mkdirSync(dex);
run(path.join(BT, 'd8'), ['--release', '--min-api', String(MIN_SDK), '--lib', ANDROID_JAR, '--output', dex, ...classFiles]);
run('zip', ['-qj', base, path.join(dex, 'classes.dex')]);

// 4. Align + sign
log('Signing');
const keyDir = path.join(os.homedir(), '.config', 'dxblock');
const keystore = process.env.DXBLOCK_KEYSTORE || path.join(keyDir, 'android-release.jks');
const passFile = path.join(keyDir, 'android-keystore.pass');
let pass = process.env.DXBLOCK_KEYSTORE_PASS;
if (!pass && fs.existsSync(passFile)) pass = fs.readFileSync(passFile, 'utf8').trim();
if (!fs.existsSync(keystore)) {
    fs.mkdirSync(path.dirname(keystore), { recursive: true });
    pass ||= crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(passFile, pass + '\n', { mode: 0o600 });
    run(jdkTool('keytool'), ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', 'dxblock', '-keyalg', 'RSA',
        '-keysize', '4096', '-validity', '18250', '-storepass', pass, '-dname', 'CN=dx.block, O=dx.bi']);
    fs.chmodSync(keystore, 0o600);
    log(`NEW signing key ${keystore}: back it up with ${passFile}, or future versions can't update installed copies`);
}
const aligned = path.join(OUT, 'aligned.apk');
// Fixed name so README can link releases/latest/download/dxblock-samsung.apk
const apk = path.join(ROOT, 'dxblock-samsung.apk');
fs.rmSync(aligned, { force: true });
run(path.join(BT, 'zipalign'), ['-f', '-p', '4', base, aligned]);
run(path.join(BT, 'apksigner'), ['sign', '--ks', keystore, '--ks-pass', `pass:${pass}`, '--out', apk, aligned]);
fs.rmSync(`${apk}.idsig`, { force: true });
run(path.join(BT, 'apksigner'), ['verify', apk]);
log(`${path.basename(apk)} (${(fs.statSync(apk).size / 1048576).toFixed(1)} MB)`);
