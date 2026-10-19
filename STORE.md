# Chrome Web Store listing (Brave installs from the Chrome Web Store)

**Name:** dx.block
**Category:** Productivity → Workflow & Planning (or "Privacy & Security")
**Short description (132 chars max):**
Fast, thorough ad blocker: ads, trackers, pop-ups, YouTube ads and malware. EasyList, uBlock and AdGuard filters. Free & open source.

**Detailed description:**
dx.block blocks ads, trackers, pop-ups and malware on every site, using the same community filter lists as uBlock Origin, AdGuard and Adblock Plus, compiled into Chrome's fast, built-in blocking engine.

• Blocks ads and trackers before they load
• Hides leftover ad boxes, including ads added after the page loads
• Defuses anti-adblock walls and YouTube ads with scriptlets
• Closes ad pop-ups and pop-unders
• Strips tracking parameters (fbclid, gclid and more) from links
• Element picker: right-click → Block element…
• One-click switch per site, custom filters and an allowlist
• Optional: cookie banners and other annoyances
• No accounts, no telemetry, nothing leaves your device. Open source (GPL-3.0).

**Single purpose:** Block ads, trackers and other unwanted content on web pages.

**Permission justifications**
- `declarativeNetRequest`: block, redirect or strip tracking parameters from ad/tracker requests using the bundled filter lists.
- `scripting`: inject the cosmetic (element-hiding) styles, scriptlets that neutralise ad and anti-adblock scripts, and the element picker.
- `storage`: save the user's settings, custom filters and allowed sites locally.
- `webNavigation`: apply per-site hiding rules as a page starts loading, and detect and close ad pop-ups.
- `contextMenus`: the "Block element…" right-click entry.
- `webRequest` (observe only): count what was blocked for the popup and badge, and detect blocked dangerous pages to show a warning.
- `webRequestAuthProvider`: answer the username/password prompt of a proxy the user configured.
- `privacy`: WebRTC IP-leak protection.
- `proxy`: optional "Hide your IP" feature routing traffic through a proxy the user enters.
- `alarms`: the daily update check and the fast-fix list refresh.
- Optional `cookies` + `browsingData` (asked only when the user turns on "Forget sites when I leave"): delete a site's cookies and storage after its last tab closes.
- Optional `contentSettings` (asked only when the user clicks "Revoke" on a site permission): block camera / microphone / location / notifications for that site.
- Host permission `<all_urls>`: ads appear on every site; the extension needs to block and hide them wherever the user browses.

**Remote code:** No. All code and filter data ship inside the package. The only remote request is a daily version check against the GitHub API (can be disabled).
**Data usage:** Collects no user data (tick "does not collect"). Privacy policy: link to PRIVACY.md on GitHub.

**Assets to prepare:** 128×128 icon (`src/icons/icon-128.png`), at least one 1280×800 screenshot (popup + a page before/after), optional 440×280 promo tile.
