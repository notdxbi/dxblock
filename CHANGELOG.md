# Changelog

## 1.4.0
- **Screen-recording alert.** Session-replay services that record your mouse, scrolling, clicks and typing (Hotjar, FullStory, Microsoft Clarity, LogRocket, Mouseflow, Smartlook and 30 more) are blocked, and the popup's *This site* tab names who tried. It also lowers the site's privacy grade
- **Cookie banners answered "Reject all".** Instead of only hiding the banner, dx.block presses "Reject all" / "Only necessary" for you, so the site records that you said no
- **Dark-pattern spotter.** Fake countdown timers, "only 2 left!" and "14 people are looking" pressure, guilt-trip buttons and pre-ticked marketing boxes are outlined in orange with an explanation on hover, and listed in the popup
- **Data breaches.** The popup warns when the site you're on leaked its users' data (Have I Been Pwned's public list, kept locally). New Settings → *Data breaches* tab: check an email address (XposedOrNot), save addresses to spot new breaches later, check a password safely (only 5 characters of its hash are sent), and look up any site
- **Privacy grades in search results.** A small A–F badge next to results for sites you've visited, and a red *breach* chip for sites that leaked data (Google, Bing, DuckDuckGo, Brave Search, Startpage, Ecosia). Nothing is sent anywhere
- **Clipboard protection.** Removes "Read more at…" text sites glue onto what you copy, stops a copied crypto wallet, IBAN or card number from being swapped, and blocks clipboard writes without a click. *Unlock copy* in the popup re-enables copy, paste, selecting and right-click on sites that block them
- **Copy clean link** in the right-click menu and the popup: tracking parameters removed, tracking redirects skipped, Amazon product links shortened
- **Lockdown mode** for one site from the popup: blocks every script and all other companies' content (images, styles and fonts still load)
- **Distraction switches** (off by default, in Settings → Privacy): hide search AI answers and sponsored results (Google AI Overviews, Bing Copilot, DuckDuckGo Search Assist, Brave), YouTube Shorts (Shorts links open as normal videos), YouTube end-screen suggestions, and Amazon sponsored products

## 1.3.0
- **Main on/off switch.** A power button in the popup (and a switch at the top of Settings) turns dx.block off everywhere and back on, without uninstalling or losing your settings. While it's off nothing is blocked or hidden, and the toolbar shows it's off
- **Allowed sites, made easy.** Add a site in the popup's *This site* tab or in Settings → Allowed sites (paste any address, it's cleaned up to the site), and remove one with ×. Pasting a whole list still works
- Fixed: Chrome showed warnings on the extensions page ("regexFilter value exceeded the 2KB memory limit") for about 100 filter rules it couldn't compile. dx.block now asks Chrome itself which rules it can compile while building and leaves the others out, so no warnings, and nothing that was working stops working
- The popup fits Chrome's 600 px limit again (it was 6 px over)
- Filter lists updated

## 1.2.1
- Fixed: the browser could freeze or stutter for up to ~20 seconds right after opening. dx.block rewrote its page-script registry on every startup; it now only does so when something changed, and registers half as many site patterns
- Filter lists updated

## 1.2.0
- Live tracker web: blocked requests fly in, get grabbed and pinned to the company behind them (popup + full-screen dashboard)
- Full-screen dashboard with live chart, company breakdown, privacy grade, protection status and weekly privacy report
- Anti-fingerprinting (canvas, WebGL, audio, fonts, hardware), with attempts shown in the popup
- Third-party cookie and tracking-beacon blocking; tracking-link unwrapping; AMP skipping
- Fake-site (look-alike / homograph) warnings, phishing blocklist, insecure-password warning, optional HTTPS-only
- Forget sites when you leave, blend-in mode (timezone & language), site permission auditor, SponsorBlock (opt-in)
- Fast fixes fetched from the repo, Report-a-problem button with a GitHub issue form

## 1.1.0
- 100% on superadblocktest.com and 132/132 on adblock.turtlecute.org (Brave, Chrome and Firefox)
- Live dashboard popup: radar, per-page counts, live feed, top blocked domains, toolbar badge
- Privacy & IP: proxy / Tor support with "Check my IP", WebRTC leak protection, Global Privacy Control, referrer stripping, notification-prompt blocking
- New lists: dx.block strict, dx.block fixes, HaGeZi Multi PRO; cookie-banner and annoyance lists on by default
- Pop-up blocker covers 60k ad/scam domains and pop-ups opened by ad frames; dangerous-page warning screen
- Firefox build (with automatic updates for signed releases), welcome page, diagnostics page, update notifications
- Fixed: the popup could open empty with protection shown as off while a page was still loading

## 1.0.0
- First release: Manifest V3 ad blocker compiling EasyList, uBlock Origin and AdGuard lists
