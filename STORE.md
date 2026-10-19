# Store submission sheet

Everything to copy into the Chrome Web Store and Firefox Add-ons forms. Build the files first with
`npm run build && npm run package`, which produces:

| File | Where it goes |
|---|---|
| `dxblock-<v>-chromium.zip` | Chrome Web Store (also used by Brave, Edge, Opera, Vivaldi) |
| `dxblock-<v>-firefox-amo.zip` | addons.mozilla.org (no `update_url`; Mozilla handles updates) |
| `dxblock-<v>-source.zip` | addons.mozilla.org "source code" upload (reviewers rebuild from it) |
| `docs/promo/*.png`, `src/icons/icon-128.png` | Store images |

---

## Shared text

**Name:** dx.block

**Short description / summary** (Chrome max 132 characters, Firefox max 250):
> Blocks ads, trackers, pop-ups, fingerprinting and scam sites, and shows you live which companies tried to track you. Free & open source.

**Detailed description:**
> dx.block blocks ads, trackers, pop-ups, cookie banners, fingerprinting and scam sites on every website, and shows you exactly what it stopped.
>
> STOP ADS AND TRACKING
> • Combines the filter lists behind uBlock Origin, AdGuard, Adblock Plus (EasyList) and HaGeZi: over 400,000 filters
> • Closes ad pop-ups and pop-unders and hides leftover ad boxes
> • Defuses anti-adblock walls and YouTube ads
> • Blocks third-party cookies and tracking beacons, and removes tracking from links (fbclid, gclid, google.com/url, l.facebook.com and more)
>
> PROTECT YOUR IDENTITY
> • Anti-fingerprinting: stops sites identifying you through canvas, WebGL, audio, fonts and hardware details
> • WebRTC leak protection and an optional proxy (Tor or your own) to hide your IP
> • Sends the Global Privacy Control "do not sell my data" signal
>
> STAY SAFE
> • Warns you about fake look-alike sites (paypa1.com, Cyrillic-letter domains) before they load
> • Blocks 30,000+ active phishing and malware sites with a clear warning screen
> • Warns before you type a password on an unencrypted page
>
> SEE WHAT'S HAPPENING
> • A live map of every request it blocks, grouped by the company behind it (Google, Meta, Amazon, TikTok…)
> • A privacy grade for every site, a full-screen dashboard and a weekly privacy report
> • Element picker, per-site switch, custom filters and allowlist
>
> PRIVATE BY DESIGN
> No account, no analytics, no telemetry. Everything runs on your device. Open source under the GPL-3.0: https://github.com/notdxbi/dxblock

**Homepage:** https://github.com/notdxbi/dxblock
**Support / issues:** https://github.com/notdxbi/dxblock/issues
**Privacy policy URL:** https://github.com/notdxbi/dxblock/blob/main/PRIVACY.md
**License:** GNU General Public License v3.0

---

## Chrome Web Store (chrome.google.com/webstore/devconsole)

**Store listing tab**
- Category: **Privacy & Security** (or Tools)
- Language: English
- Store icon: `src/icons/icon-128.png`
- Screenshots (1280×800): `docs/promo/store-1-popup.png`, `store-2-dashboard.png`, `store-3-privacy.png`
- Small promo tile (440×280): `docs/promo/promo-tile-440x280.png`
- Marquee promo tile (1400×560): `docs/promo/marquee-1400x560.png`
- Official URL: none (needs a verified domain); Homepage URL and Support URL: as above

**Privacy practices tab**
- **Single purpose:** Block ads, trackers and other unwanted or harmful content on web pages, and show the user what was blocked.
- **Permission justifications:**
  - `declarativeNetRequest`: block, redirect or strip tracking parameters from ad and tracker requests using the bundled filter lists.
  - `scripting`: inject element-hiding styles, scriptlets that neutralise ad and anti-adblock scripts, anti-fingerprinting protection and the element picker.
  - `storage`: save the user's settings, custom filters, allowed sites and local statistics.
  - `webNavigation`: apply per-site hiding rules as a page starts loading, warn about fake sites, and detect and close ad pop-ups.
  - `webRequest`: observe (not modify) requests so the popup can count what was blocked, and show a warning page when a dangerous page is blocked.
  - `webRequestAuthProvider`: answer the username/password prompt of a proxy the user configured themselves.
  - `contextMenus`: the "Block element…" right-click entry.
  - `privacy`: WebRTC IP-leak protection.
  - `proxy`: the optional "Hide your IP" feature, which routes traffic through a proxy the user enters.
  - `alarms`: periodic update check and filter fix refresh.
  - Optional `cookies`, `browsingData`: only requested when the user turns on "Forget sites when I leave".
  - Optional `contentSettings`: only requested when the user clicks "Revoke" on a site's camera/microphone/location/notification permission.
  - **Host permission `<all_urls>`:** ads and trackers appear on every website; the extension must block and hide them wherever the user browses.
- **Remote code:** **No, I am not using remote code.** All JavaScript ships in the package. (The extension downloads a small *filter list* text file from its GitHub repository, which is data, not code.)
- **Data usage:** tick nothing (the extension collects no user data), then confirm the three certifications.

**Package tab:** upload `dxblock-<v>-chromium.zip`.
**Distribution:** Public, all regions.

---

## Firefox Add-ons (addons.mozilla.org/developers)

**Submit a New Add-on → On this site** (listed; Mozilla signs it and delivers updates)
1. Upload `dxblock-<v>-firefox-amo.zip`, compatible with **Firefox** (desktop).
2. "Do you need to submit source code?" → **Yes**, upload `dxblock-<v>-source.zip`.
3. Listing:
   - Name, Summary, Description: shared text above
   - Categories: **Privacy & Security**
   - Tags: ad blocker, privacy, tracker blocker, anti-fingerprinting, phishing
   - Support email or site: https://github.com/notdxbi/dxblock/issues
   - License: GNU GPL v3.0
   - Privacy policy: paste the contents of `PRIVACY.md`
   - Screenshots: the three `docs/promo/store-*.png` images
4. **Notes to reviewer** (paste):

> dx.block is open source: https://github.com/notdxbi/dxblock (GPL-3.0). The uploaded source archive is the same commit.
>
> Build: Node.js 22, then `npm ci && npm run build && npm run package`. The Firefox package is `dxblock-<version>-firefox-amo.zip` (built from `dist-firefox/`).
>
> Generated and third-party files:
> - `rulesets/*.json`, `data/*.json`, `scriptlets/*.js`, `lib/scriptlet-lib.js`: generated by `tools/build.mjs` from public filter lists (EasyList, uBlock Origin, AdGuard, HaGeZi and others, listed in `tools/lists.mjs`). The build downloads the lists, so a rebuild on another day can differ slightly in filter content.
> - `lib/extended-css.js`: AdGuard ExtendedCss 2.3.0 (`@adguard/extended-css`, unmodified minified build from npm). Scriptlet functions come from `@adguard/scriptlets` 2.5.1.
> - `redirects/*`: AdGuard redirect resources (no-op stand-ins for ad scripts).
>
> Network requests made by the extension itself: GitHub API (daily version check, can be disabled), raw.githubusercontent.com (small filter-fix text file, can be disabled), api.ipify.org (only when the user clicks "Check my IP"), sponsor.ajay.app (opt-in SponsorBlock, sends a 4-character hash prefix only). No user data is collected.
>
> Testing: install, open any site with ads (e.g. https://adblock.turtlecute.org/), then click the toolbar button to see the live dashboard.

---

## After approval
- Put the store links at the top of the README (badges) and in the release notes.
- Chrome: upload each new `-chromium.zip` as an update (Package tab → Upload new package).
- Firefox: upload each new `-firefox-amo.zip` plus its source zip as a new version.
