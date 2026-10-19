# dx.block privacy policy

dx.block does not collect, store, sell or transmit any personal data.

- **No accounts, no analytics, no telemetry.** dx.block has no servers and never reports on you.
- **Everything stays on your device.** Settings, custom filters, allowed sites and statistics are kept in the browser's local extension storage.
- **Page access is only used to block and hide ads.** Pages and requests are processed locally and never recorded or sent anywhere.
- **Filter lists are bundled** into each release; the installed extension doesn't download them.

The only network requests dx.block itself makes:
- **Update check** (can be switched off in Settings → About): once a day it asks the public GitHub API for the latest dx.block release version. No identifiers are sent.
- **"Check my IP"** (only when you click it): one request to `api.ipify.org` to show the IP address websites see.
- **Proxy** (only if you configure one): your browsing goes through the proxy server *you* entered.
- **Fast fixes** (can be switched off): a few times a day it downloads a small filter file from this GitHub repository. Nothing about you is sent.
- **SponsorBlock** (off by default): on YouTube, it asks `sponsor.ajay.app` for sponsor segments using only the first 4 characters of a SHA-256 hash of the video ID, so the service can't tell which video you're watching.
- **Report a problem** opens a pre-filled GitHub issue in a new tab. Nothing is sent unless you choose to submit it.

Features like anti-fingerprinting, the privacy grade, company breakdown, dashboard, weekly report and "forget sites when I leave" run entirely on your device.

Questions: open an issue at https://github.com/notdxbi/dxblock/issues
