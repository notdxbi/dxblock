#!/usr/bin/env node
// Adds a signed Firefox release to updates/firefox.json (the add-on's update_url).
//   node tools/firefox-update.mjs <version>
import fs from 'node:fs';
const version = process.argv[2];
const file = new URL('../updates/firefox.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const list = data.addons['dxblock@notdxbi'].updates.filter((u) => u.version !== version);
list.push({ version, update_link: `https://github.com/notdxbi/dxblock/releases/download/v${version}/dxblock-${version}-firefox.xpi` });
data.addons['dxblock@notdxbi'].updates = list.slice(-5);
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
console.log(`:: updates/firefox.json -> ${version}`);
