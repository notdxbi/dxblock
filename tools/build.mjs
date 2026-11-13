#!/usr/bin/env node
// Builds dx.block into dist/:
//   node tools/build.mjs            download fresh lists, compile, package
//   node tools/build.mjs --offline  reuse the cached lists in .cache/lists
import { checkRegexes, regexKey } from './regex-check.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { scriptlets } from '@adguard/scriptlets';
import * as conv from '@adguard/scriptlets/converters';
import {
    preprocess, classify, convertNetworkFilter, convertCosmeticFilter, mergeRules,
    genericKey, registerRedirect, isHostname, REDIRECT_ALIASES, baseDomain, bucketOf, BUCKETS
} from '../src/lib/filters.js';
import { LISTS } from './lists.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, '.cache', 'lists');
const OFFLINE = process.argv.includes('--offline');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SCRIPTLETS_DIR = path.join(ROOT, 'node_modules', '@adguard', 'scriptlets');
const SCRIPTLETS_VERSION = JSON.parse(fs.readFileSync(path.join(SCRIPTLETS_DIR, 'package.json'), 'utf8')).version;

const MAX_REGEX_PER_RULESET = 1000;

const log = (...a) => console.log('::', ...a);
const write = (rel, data) => {
    const p = path.join(DIST, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
};

// ---------------------------------------------------------------------------
// 1. Download lists (with !#include files)
// ---------------------------------------------------------------------------
async function fetchText(url, cacheName) {
    if (url.startsWith('local:')) return fs.readFileSync(path.join(ROOT, url.slice(6)), 'utf8');
    const file = path.join(CACHE, cacheName);
    if (OFFLINE && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    const res = await fetch(url, { headers: { 'user-agent': `dx.block-build/${PKG.version}` } });
    if (!res.ok) {
        if (fs.existsSync(file)) { log(`  ! ${url} -> HTTP ${res.status}, using cached copy`); return fs.readFileSync(file, 'utf8'); }
        throw new Error(`${url}: HTTP ${res.status}`);
    }
    const text = await res.text();
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, text);
    return text;
}

async function loadList(list) {
    const includes = new Map();
    const collect = async (text, base) => {
        for (const m of text.matchAll(/^!#include\s+(\S+)/gm)) {
            const url = new URL(m[1], base).href;
            if (includes.has(m[1])) continue;
            const sub = await fetchText(url, `${list.id}__${m[1].replace(/[^\w.-]/g, '_')}`);
            includes.set(m[1], sub);
            await collect(sub, url);
        }
    };
    const text = await fetchText(list.url, `${list.id}.txt`);
    await collect(text, list.url);
    return preprocess(text, (name) => includes.get(name) || '');
}

// ---------------------------------------------------------------------------
// 2. Scriptlets
// ---------------------------------------------------------------------------
const corelibs = JSON.parse(fs.readFileSync(path.join(SCRIPTLETS_DIR, 'dist', 'scriptlets.corelibs.json'), 'utf8')).scriptlets;
const CANONICAL = new Map();           // any alias -> canonical AdGuard name
for (const s of corelibs) for (const n of s.names) CANONICAL.set(n, s.names[0]);

function parseScriptletArgs(str) {
    const out = [];
    let i = 0;
    while (i < str.length) {
        while (i < str.length && /[\s,]/.test(str[i])) i++;
        if (i >= str.length) break;
        const q = str[i];
        if (q !== '"' && q !== "'") return null;
        let v = '';
        i++;
        while (i < str.length && str[i] !== q) {
            if (str[i] === '\\' && i + 1 < str.length) { v += str[i + 1]; i += 2; continue; }
            v += str[i++];
        }
        i++;
        out.push(v);
    }
    return out;
}

function makeScriptletConverter(trusted) {
    return (ruleText) => {
        if (/#@?#\+js\(\s*\)$/.test(ruleText)) return [{ name: '*', args: [] }];   // "#@#+js()" = all scriptlets off
        let adg;
        try {
            if (/#@?#\+js\(/.test(ruleText)) adg = conv.convertUboToAdg(ruleText);
            else if (/#@?\$#/.test(ruleText)) adg = conv.convertAbpToAdg(ruleText);
            else adg = [ruleText];
        } catch { return null; }
        const calls = [];
        for (const r of adg || []) {
            const m = /#@?%#\/\/scriptlet\((.*)\)\s*$/.exec(r);
            if (!m) continue;
            const parts = parseScriptletArgs(m[1]);
            if (!parts || !parts.length) continue;
            const name = CANONICAL.get(parts[0]) || CANONICAL.get(parts[0].replace(/^ubo-/, ''));
            if (!name) continue;
            if (name.startsWith('trusted-') && !trusted) continue;
            if (!scriptlets.getScriptletFunction(name)) continue;
            calls.push({ name, args: parts.slice(1) });
        }
        return calls;
    };
}

// ---------------------------------------------------------------------------
// 3. Redirect resources
// ---------------------------------------------------------------------------
const EXT = { 'image/gif': 'gif', 'image/png': 'png', 'text/html': 'html', 'text/css': 'css',
    'application/javascript': 'js', 'application/json': 'json', 'text/plain': 'txt', 'text/xml': 'xml',
    'audio/mp3': 'mp3', 'video/mp4': 'mp4' };

function buildRedirects() {
    const entries = JSON.parse(fs.readFileSync(path.join(SCRIPTLETS_DIR, 'dist', 'redirects.json'), 'utf8'));
    for (const e of entries) {
        if (e.isBlocking) continue;
        const [mime, enc] = e.contentType.split(';');
        const ext = EXT[mime];
        if (!ext) continue;
        const file = e.title.endsWith(`.${ext}`) ? e.title : `${e.title}.${ext}`;
        write(`redirects/${file}`, enc === 'base64' ? Buffer.from(e.content, 'base64') : e.content);
        registerRedirect(file, [e.title, ...(e.aliases || [])]);
    }
    write('data/redirects.json', JSON.stringify(REDIRECT_ALIASES));
    log(`redirect resources: ${new Set(Object.values(REDIRECT_ALIASES)).size}`);
}

// ---------------------------------------------------------------------------
// 4. Cosmetic stores
// ---------------------------------------------------------------------------
function newGroup() {
    return {
        genericHide: new Set(),
        genericExcGlobal: new Set(),
        genericExc: new Map(),       // host -> Set(selector)
        specific: new Map(),         // host -> { h:Set, x:Set, c:Set }
        extended: new Map(),         // host -> { r:Set, x:Set }
        scriptlets: new Map(),       // canonical name -> Map(host -> Set(argsJSON))
        scriptletExc: new Map(),     // host -> Set('*' | name + '\0' + argsJSON)
        entity: { hide: new Map(), css: new Map(), ext: new Map(), scriptlets: new Map() }
    };
}
const getOr = (map, key, mk) => { let v = map.get(key); if (!v) { v = mk(); map.set(key, v); } return v; };

function addCosmetic(g, e) {
    const { include, exclude, entityInclude } = e.domains;
    const isGeneric = !include.length && !entityInclude.length;

    if (e.type === 'hide') {
        if (e.exception) {
            if (isGeneric) { g.genericExcGlobal.add(e.selector); return; }
            for (const h of include) {
                getOr(g.specific, h, () => ({ h: new Set(), x: new Set(), c: new Set() })).x.add(e.selector);
                getOr(g.genericExc, h, () => new Set()).add(e.selector);
            }
            return;
        }
        if (isGeneric) {
            g.genericHide.add(e.selector);
            for (const h of exclude) getOr(g.genericExc, h, () => new Set()).add(e.selector);
            return;
        }
        for (const h of include) getOr(g.specific, h, () => ({ h: new Set(), x: new Set(), c: new Set() })).h.add(e.selector);
        for (const h of exclude) getOr(g.specific, h, () => ({ h: new Set(), x: new Set(), c: new Set() })).x.add(e.selector);
        for (const h of entityInclude) getOr(g.entity.hide, h, () => new Set()).add(e.selector);
        return;
    }
    if (e.type === 'css') {
        if (isGeneric) return;                                       // generic style injection: not worth the risk
        for (const h of include) {
            const s = getOr(g.specific, h, () => ({ h: new Set(), x: new Set(), c: new Set() }));
            if (e.exception) s.x.add(e.css); else s.c.add(e.css);
        }
        if (!e.exception) for (const h of entityInclude) getOr(g.entity.css, h, () => new Set()).add(e.css);
        return;
    }
    if (e.type === 'extended') {
        if (isGeneric) return;                                       // generic procedural filters are too slow
        for (const h of include) {
            const s = getOr(g.extended, h, () => ({ r: new Set(), x: new Set() }));
            if (e.exception) s.x.add(e.rule); else s.r.add(e.rule);
        }
        for (const h of exclude) getOr(g.extended, h, () => ({ r: new Set(), x: new Set() })).x.add(e.rule);
        if (!e.exception) for (const h of entityInclude) getOr(g.entity.ext, h, () => new Set()).add(e.rule);
        return;
    }
    if (e.type === 'scriptlet') {
        for (const { name, args } of e.calls) {
            const key = JSON.stringify(args);
            if (e.exception) {
                for (const h of include) getOr(g.scriptletExc, h, () => new Set()).add(name === '*' ? '*' : `${name}\0${key}`);
                continue;
            }
            if (name === '*' || isGeneric) continue;                 // generic scriptlets are not allowed
            const byHost = getOr(g.scriptlets, name, () => new Map());
            for (const h of include) getOr(byHost, h, () => new Set()).add(key);
            for (const h of exclude) getOr(g.scriptletExc, h, () => new Set()).add(`${name}\0${key}`);
            for (const h of entityInclude) getOr(g.entity.scriptlets, h, () => []).push([name, args]);
        }
    }
}


const isIp = (h) => /^\d+\.\d+\.\d+\.\d+$/.test(h);
// `*://*.example.com/*` already matches example.com itself, and a host whose parent
// domain is listed is covered by the parent's pattern (scriptlets walk parent domains).
// Chrome's cost of loading registered scripts grows faster than linearly with the
// pattern count (112k patterns froze the browser UI ~20s at startup), so keep it minimal.
function matchPatterns(hosts) {
    const set = new Set(hosts.filter(isHostname));
    const covered = (h) => { for (let i = h.indexOf('.'); i >= 0; i = h.indexOf('.', i + 1)) if (set.has(h.slice(i + 1))) return true; return false; };
    const out = [];
    for (const h of set) {
        if (isIp(h)) out.push(`*://${h}/*`);
        else if (!covered(h)) out.push(`*://*.${h}/*`);
    }
    return out;
}

// Content-script templates ----------------------------------------------------
// Walks the hostname and its parent domains: a.b.example.com, b.example.com, example.com
const HOST_WALK = `const h=location.hostname||(()=>{try{return new URL(document.referrer||top.location.href).hostname}catch(e){return''}})();if(!h)return;const ds=[];{let d=h;for(;;){ds.push(d);const i=d.indexOf('.');if(i<0)break;d=d.slice(i+1)}}`;

function scriptletScript(name, fnSource, map, exc) {
    return `/* dx.block scriptlet "${name}" (generated; scriptlet code by AdGuard, GPL-3.0) */
(()=>{const N=${JSON.stringify(name)};const M=${JSON.stringify(map)};const X=${JSON.stringify(exc)};${HOST_WALK}
const off=new Set();for(const d of ds){const x=X[d];if(!x)continue;for(const k of x){if(k==='*')return;off.add(k)}}
const calls=new Set();for(const d of ds){const m=M[d];if(m)for(const a of m)if(!off.has(a))calls.add(a)}if(!calls.size)return;
const fn=${fnSource};
for(const a of calls){const args=JSON.parse(a);try{fn({name:N,args,engine:'extension',version:'${SCRIPTLETS_VERSION}',verbose:false,ruleText:''},args)}catch(e){}}})();
`;
}

// ---------------------------------------------------------------------------
// 5. Build
// ---------------------------------------------------------------------------
async function main() {
    fs.rmSync(DIST, { recursive: true, force: true });
    fs.mkdirSync(DIST, { recursive: true });
    buildRedirects();

    log('downloading lists' + (OFFLINE ? ' (offline)' : ''));
    const lines = {};
    await Promise.all(LISTS.map(async (l) => { lines[l.id] = await loadList(l); }));

    // $badfilter applies across all lists
    const badfilters = new Set();
    for (const l of LISTS) for (const line of lines[l.id]) {
        if (/[$,]badfilter\b/.test(line)) {
            const r = convertNetworkFilter(line);
            if (r?.badfilter) badfilters.add(r.badfilter);
        }
    }

    const groups = { ads: newGroup(), annoyances: newGroup() };
    const flags = new Map();          // host -> Set('elemhide'|'generichide'|'specifichide')
    const rulesets = [];
    const stats = {};
    const popups = [];
    const compiled = [];

    for (const list of LISTS) {
        const g = groups[list.group];
        const convertScriptlet = makeScriptletConverter(!!list.trusted);
        const rules = [];
        let net = 0, cos = 0, skipped = 0;
        for (const line of lines[list.id]) {
            const c = classify(line);
            if (!c) continue;
            if (c.kind === 'network') {
                if (badfilters.has(c.text)) continue;
                const r = convertNetworkFilter(c.text);
                if (!r) { skipped++; continue; }
                if (r.cosmeticException) {
                    const f = getOr(flags, r.cosmeticException.host, () => new Set());
                    r.cosmeticException.kinds.forEach((k) => f.add(k));
                }
                if (r.popup) { popups.push(r.popup); net++; continue; }
                rules.push(...r.rules);
                net += r.rules.length;
            } else {
                const e = convertCosmeticFilter(c, convertScriptlet);
                if (!e) { skipped++; continue; }
                addCosmetic(g, e);
                cos++;
            }
        }

        // Lists of dangerous sites also block opening them (shows the warning page)
        if (list.document) for (const r of rules) {
            if (r.action.type === 'block' && !r.condition.resourceTypes) r.condition.resourceTypes = ['main_frame', 'sub_frame', 'script', 'image', 'stylesheet', 'xmlhttprequest', 'font', 'media', 'object', 'other', 'ping', 'websocket'];
        }
        // Merge, validate, number
        let merged = stealthSplit(mergeRules(rules));
        let regex = 0;
        merged = merged.filter((r) => {
            if (!r.condition.regexFilter) return true;
            return ++regex <= MAX_REGEX_PER_RULESET;
        });
        compiled.push({ list, merged });
        stats[list.id] = { filters: net, cosmetic: cos, rules: merged.length, skipped };
        log(`${list.id.padEnd(22)} network ${String(net).padStart(6)} -> ${String(merged.length).padStart(6)} rules · cosmetic ${String(cos).padStart(6)} · skipped ${skipped}`);
    }

    // Query-parameter removal: Chrome runs one transform per request even across rulesets, so every
    // removeparam rule carries the site-wide parameters of all lists
    const rpParams = (r) => r.action.type === 'redirect' && r.action.redirect.transform?.queryTransform?.removeParams;
    const globalParams = new Set();
    for (const { merged } of compiled) for (const r of merged) {
        if (rpParams(r) && Object.keys(r.condition).every((k) => k === 'resourceTypes')) rpParams(r).forEach((p) => globalParams.add(p));
    }
    // The same rule often appears in several lists: keep only the first copy (saves rule budget)
    const seenRules = new Set();
    let dupes = 0;
    for (const c of compiled) {
        c.merged = c.merged.filter((r) => {
            if (rpParams(r)) return true;
            const key = JSON.stringify([r.priority, r.action, r.condition]);
            if (seenRules.has(key)) { dupes++; return false; }
            seenRules.add(key);
            return true;
        });
        stats[c.list.id].rules = c.merged.length;
    }
    log(`duplicate rules removed across lists: ${dupes}`);
    // Chrome skips (with a warning on chrome://extensions) any regex over its 2 KB compiled-memory limit:
    // ask Chrome which ones it can't compile and leave them out
    const regexItems = [];
    for (const { merged } of compiled) for (const r of merged) {
        if (r.condition.regexFilter) regexItems.push({ regex: r.condition.regexFilter, caseSensitive: !!r.condition.isUrlFilterCaseSensitive });
    }
    const regexOk = await checkRegexes(regexItems);
    if (regexOk) {
        let tooBig = 0;
        for (const c of compiled) {
            c.merged = c.merged.filter((r) => {
                if (!r.condition.regexFilter) return true;
                const ok = regexOk.get(regexKey(r.condition.regexFilter, !!r.condition.isUrlFilterCaseSensitive));
                if (!ok) tooBig++;
                return ok;
            });
            stats[c.list.id].rules = c.merged.length;
        }
        log(`regex rules Chrome can't compile (2 KB limit), left out: ${tooBig} of ${regexItems.length}`);
    }
    for (const { list, merged } of compiled) {
        for (const r of merged) {
            const p = rpParams(r);
            if (p) r.action.redirect.transform.queryTransform.removeParams = [...new Set([...p, ...globalParams])];
        }
        // Store validators (Firefox AMO) can't parse JSON files over ~4 MB: split big lists into chunks
        const chunks = chunkRules(merged);
        const ids = [];
        chunks.forEach((chunk, n) => {
            const id = n ? `${list.id}~${n + 1}` : list.id;
            chunk.forEach((r, i) => { r.id = i + 1; });
            write(`rulesets/${id}.json`, JSON.stringify(chunk));
            rulesets.push({ id, enabled: list.on, path: `rulesets/${id}.json` });
            ids.push(id);
        });
        stats[list.id].rulesets = ids;
    }
    log(`site-wide tracking parameters stripped: ${globalParams.size}`);
    write('data/params.json', JSON.stringify([...globalParams].sort()));   // used by "Copy clean link"

    // Domains whose pop-ups are always closed: ad servers, malware and scam hosts
    const popupDomains = new Set();
    for (const { list, merged } of compiled) {
        if (!['pgl', 'urlhaus', 'ubo-badware', 'easylist'].includes(list.id)) continue;
        for (const r of merged) {
            const c = r.condition;
            if (r.action.type !== 'block' || !c.requestDomains || c.initiatorDomains || c.domainType) continue;
            if (list.id === 'easylist' && (c.resourceTypes || c.excludedInitiatorDomains)) continue;
            c.requestDomains.forEach((d) => popupDomains.add(d));
        }
    }
    for (const p of popups) {
        const m = /^\^\[a-z\]\[a-z0-9\+\.-\]\*:\\\/\\\/\(\?:\[\^\\\/\?#\]\+\\\.\)\?([\w\\.-]+)\(\?:/.exec(p.re);
        if (m && !p.allow && !p.d) popupDomains.add(m[1].replace(/\\\./g, '.'));
    }
    write('data/popup-domains.json', JSON.stringify([...popupDomains]));
    log(`pop-up ad domains: ${popupDomains.size}`);

    const registry = [];
    const usedScriptlets = new Set();
    for (const [gname, g] of Object.entries(groups)) {
        // Specific hiding / CSS injection / procedural rules: bucketed JSON the service worker loads per site
        const buckets = Array.from({ length: BUCKETS }, () => ({}));
        for (const [h, v] of g.specific) {
            const o = {};
            if (v.h.size) o.h = [...v.h];
            if (v.x.size) o.x = [...v.x];
            if (v.c.size) o.c = [...v.c];
            if (Object.keys(o).length) buckets[bucketOf(h)][h] = o;
        }
        for (const [h, v] of g.extended) {
            const o = (buckets[bucketOf(h)][h] ||= {});
            if (v.r.size) o.r = [...v.r];
            if (v.x.size) o.x = [...(o.x || []), ...v.x];
        }
        buckets.forEach((b, i) => write(`data/${gname}-sites-${i}.json`, JSON.stringify(b)));

        // Scriptlets: one MAIN-world file per scriptlet
        for (const [name, byHost] of g.scriptlets) {
            const map = {};
            for (const [h, set] of byHost) map[h] = [...set];
            const bases = new Set(Object.keys(map).map(baseDomain));
            const exc = {};
            for (const [h, set] of g.scriptletExc) {
                const keys = [...set].filter((k) => k === '*' || k.startsWith(name + '\0')).map((k) => (k === '*' ? k : k.slice(name.length + 1)));
                if (keys.length && bases.has(baseDomain(h))) exc[h] = keys;
            }
            const file = `scriptlets/${gname}-${name}.js`;
            const src = String(scriptlets.getScriptletFunction(name));
            write(file, scriptletScript(name, src, map, exc));
            usedScriptlets.add(name);
            registry.push({ id: `${gname}-js-${name}`, group: gname, js: [file], matches: matchPatterns(Object.keys(map)), world: 'MAIN' });
        }

        // Generic hiding, keyed by class/id (looked up lazily by content/cosmetic.js)
        const keys = {};
        const high = [];
        for (const sel of g.genericHide) {
            if (g.genericExcGlobal.has(sel)) continue;
            const k = genericKey(sel);
            if (!k) { high.push(sel); continue; }
            if (sel === k) { if (!keys[k]) keys[k] = 1; else if (Array.isArray(keys[k])) keys[k].unshift(k); continue; }
            if (keys[k] === 1) keys[k] = [k, sel];
            else (keys[k] ||= []).push(sel);
        }
        const exc = {};
        for (const [h, s] of g.genericExc) exc[h] = [...s];
        write(`data/${gname}-generic.json`, JSON.stringify({ keys, high, exc }));

        // Entity filters (google.*) — handled by the service worker at navigation time
        const ent = {
            hide: Object.fromEntries([...g.entity.hide].map(([k, v]) => [k, [...v]])),
            css: Object.fromEntries([...g.entity.css].map(([k, v]) => [k, [...v]])),
            ext: Object.fromEntries([...g.entity.ext].map(([k, v]) => [k, [...v]])),
            scriptlets: Object.fromEntries(g.entity.scriptlets)
        };
        for (const calls of Object.values(ent.scriptlets)) for (const [n] of calls) usedScriptlets.add(n);
        write(`data/${gname}-entity.json`, JSON.stringify(ent));
        log(`${gname}: generic ${Object.keys(keys).length} keys + ${high.length} high · specific ${g.specific.size} hosts · procedural ${g.extended.size} hosts · scriptlets ${g.scriptlets.size} kinds`);
    }

    // Generic-hiding exceptions from network filters ($generichide / $elemhide)
    const ghide = {};
    const shide = {};
    for (const [h, f] of flags) {
        if (f.has('generichide') || f.has('elemhide')) ghide[h] = 1;
        if (f.has('specifichide') || f.has('elemhide')) shide[h] = 1;
    }
    write('data/flags.json', JSON.stringify({ generichide: ghide, specifichide: shide }));
    write('data/registry.json', JSON.stringify(registry));
    write('data/popups.json', JSON.stringify(popups));
    log(`pop-up filters: ${popups.length}`);
    write('data/lists.json', JSON.stringify(LISTS.map(({ id, cat, name, desc, group, on, home }) => ({ id, cat, name, desc, group, on, home, ...stats[id] }))));

    // Every AdGuard scriptlet for the service worker (entity filters + user filters)
    let lib = `// Generated: AdGuard scriptlets ${SCRIPTLETS_VERSION} (GPL-3.0), https://github.com/AdguardTeam/Scriptlets\nexport const VERSION = ${JSON.stringify(SCRIPTLETS_VERSION)};\nexport const ALIASES = ${JSON.stringify(Object.fromEntries(CANONICAL))};\nexport const S = {\n`;
    for (const s of corelibs) {
        const n = s.names[0];
        const fn = scriptlets.getScriptletFunction(n);
        if (fn) lib += `${JSON.stringify(n)}: ${String(fn)},\n`;
    }
    write('lib/scriptlet-lib.js', lib + '};\n');

    // Static files
    copyDir(path.join(ROOT, 'src'), DIST);
    fs.copyFileSync(path.join(ROOT, 'node_modules', '@adguard', 'extended-css', 'dist', 'extended-css.min.js'), path.join(DIST, 'lib', 'extended-css.js'));

    // Manifest
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'manifest.json'), 'utf8'));
    manifest.version = PKG.version;
    manifest.declarative_net_request = { rule_resources: rulesets };
    write('manifest.json', JSON.stringify(manifest, null, 2));

    buildFirefox(manifest);

    const total = LISTS.filter((l) => l.on).reduce((n, l) => n + stats[l.id].rules, 0);
    log(`default-enabled network rules: ${total}`);
    log(`registered content scripts: ${registry.length}`);
    log(`built dist/ (v${PKG.version})`);
}

// uBO answers generic ad-domain XHRs with an empty response ("stealth") so anti-adblock scripts can't tell.
// Detectors fetch the well-known ad *scripts*, so keep the stealth reply for .js URLs and hard-block the rest.
function stealthSplit(rules) {
    const out = [];
    for (const r of rules) {
        const c = r.condition;
        const stealth = r.action.type === 'redirect' && r.action.redirect.extensionPath
            && /\/(nooptext|noopjs|noopjson)\./.test(r.action.redirect.extensionPath)
            && (!c.resourceTypes || c.resourceTypes.includes('xmlhttprequest'))
            && !c.initiatorDomains && !c.regexFilter;
        if (!stealth) { out.push(r); continue; }
        out.push({ priority: r.priority, action: { type: 'block' }, condition: c });
        if (!c.urlFilter) out.push({ priority: r.priority + 1, action: r.action, condition: { ...c, urlFilter: '.js' } });
    }
    return out;
}

const CHUNK_BYTES = 3_500_000;
function chunkRules(rules) {
    // Very large domain lists in one rule (HaGeZi: 200k domains) are split first
    const exploded = [];
    for (const r of rules) {
        const d = r.condition.requestDomains;
        if (!d || d.length <= 25_000) { exploded.push(r); continue; }
        for (let i = 0; i < d.length; i += 25_000) exploded.push({ ...r, condition: { ...r.condition, requestDomains: d.slice(i, i + 25_000) } });
    }
    const chunks = [[]];
    let bytes = 0;
    for (const r of exploded) {
        const size = JSON.stringify(r).length + 1;
        if (bytes + size > CHUNK_BYTES && chunks[chunks.length - 1].length) { chunks.push([]); bytes = 0; }
        chunks[chunks.length - 1].push(r);
        bytes += size;
    }
    return chunks;
}

// Firefox build (dist-firefox/): event-page background, Gecko settings, and only DNR features Firefox supports
const FIREFOX_TYPES = new Set(['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
    'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other']);
function buildFirefox(chromeManifest) {
    const FF = path.join(ROOT, 'dist-firefox');
    fs.rmSync(FF, { recursive: true, force: true });
    fs.cpSync(DIST, FF, { recursive: true });
    const m = structuredClone(chromeManifest);
    m.background = { scripts: ['background.js'], type: 'module' };
    m.browser_specific_settings = { gecko: {
        id: 'dxblock@notdxbi', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] },
        // Self-distributed, Mozilla-signed builds update from the repo (see .github/workflows/release.yml)
        update_url: 'https://raw.githubusercontent.com/notdxbi/dxblock/main/updates/firefox.json'
    } };
    m.permissions = m.permissions.filter((p) => p !== 'webRequestAuthProvider').concat('webRequestBlocking');
    m.optional_permissions = (m.optional_permissions || []).filter((p) => p !== 'contentSettings');
    for (const cs of m.content_scripts) delete cs.match_origin_as_fallback;
    for (const w of m.web_accessible_resources) delete w.use_dynamic_url;
    delete m.minimum_chrome_version;
    // Firefox: 30k static rules, 5k dynamic+session rules, 20 enabled rulesets, 1k regex rules in total.
    // The malware URL list alone is 22k rules and Firefox already has Safe Browsing, so it's off by default here;
    // a couple of small lists move to dynamic rules if the static budget is still exceeded.
    const lists = JSON.parse(fs.readFileSync(path.join(FF, 'data', 'lists.json'), 'utf8'));
    const urlhaus = lists.find((l) => l.id === 'urlhaus');
    if (urlhaus) { urlhaus.on = false; urlhaus.desc += ' (off by default in Firefox, which has Safe Browsing built in)'; }
    const MOVABLE = ['adguard-url-tracking', 'adguard-cookies', 'ubo-badware', 'ubo-cookies'];
    const staticTotal = () => lists.filter((l) => l.on && !l.dynamic).reduce((n, l) => n + l.rules, 0);
    let dynamicTotal = 0;
    for (const id of MOVABLE) {
        if (staticTotal() <= 29_500) break;
        const l = lists.find((x) => x.id === id);
        if (!l?.on || dynamicTotal + l.rules > 4_000) continue;
        l.dynamic = true;
        dynamicTotal += l.rules;
    }
    for (const r of m.declarative_net_request.rule_resources) {
        const l = lists.find((x) => (x.rulesets || [x.id]).includes(r.id));
        r.enabled = !!l?.on && !l.dynamic;
    }
    const dynIds = new Set(lists.filter((l) => l.dynamic).flatMap((l) => l.rulesets));
    m.declarative_net_request.rule_resources = m.declarative_net_request.rule_resources.filter((r) => !dynIds.has(r.id));
    fs.writeFileSync(path.join(FF, 'data', 'lists.json'), JSON.stringify(lists));
    log(`firefox: ${staticTotal()} static + ${dynamicTotal} dynamic rules (${[...lists.filter((l) => l.dynamic).map((l) => l.id)].join(', ')})`);
    fs.writeFileSync(path.join(FF, 'manifest.json'), JSON.stringify(m, null, 2));
    let regexBudget = 950;
    for (const r of chromeManifest.declarative_net_request.rule_resources) {
        const file = path.join(FF, r.path);
        const rules = JSON.parse(fs.readFileSync(file, 'utf8')).filter((rule) => {
            const c = rule.condition;
            if (c.regexFilter && --regexBudget < 0) return false;
            for (const k of ['resourceTypes', 'excludedResourceTypes']) {
                if (!c[k]) continue;
                c[k] = c[k].filter((x) => FIREFOX_TYPES.has(x));
                if (!c[k].length) { if (k === 'resourceTypes') return false; delete c[k]; }
            }
            return true;
        });
        fs.writeFileSync(file, JSON.stringify(rules));
    }
    log('built dist-firefox/');
}

function copyDir(src, dst) {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        if (e.name === 'manifest.json' && src.endsWith('src')) continue;
        const s = path.join(src, e.name);
        const d = path.join(dst, e.name);
        if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDir(s, d); }
        else fs.copyFileSync(s, d);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
