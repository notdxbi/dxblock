// Filter lists bundled with dx.block.
//   group: which cosmetic bundle the list feeds ("ads" or "annoyances")
//   trusted: may use trusted-* scriptlets (only lists maintained by uBO / AdGuard)
export const LISTS = [
    { id: 'dxblock-fixes', cat: 'ads', name: 'dx.block fixes', desc: 'Gaps found by dx.block\'s own testing', group: 'ads', on: true, trusted: true,
      url: 'local:tools/fixes.txt', home: 'https://github.com/notdxbi/dxblock' },
    // --- Ads ---------------------------------------------------------------
    { id: 'easylist', cat: 'ads', name: 'EasyList', desc: 'The main ad-blocking list', group: 'ads', on: true,
      url: 'https://easylist.to/easylist/easylist.txt', home: 'https://easylist.to/' },
    { id: 'ubo-filters', cat: 'ads', name: 'uBlock filters', desc: 'Ads, anti-adblock and YouTube fixes from uBlock Origin', group: 'ads', on: true, trusted: true,
      url: 'https://ublockorigin.github.io/uAssets/filters/filters.txt', home: 'https://github.com/uBlockOrigin/uAssets' },
    { id: 'ubo-quick', cat: 'ads', name: 'uBlock quick fixes', desc: 'Fast-moving fixes (YouTube, Twitch, anti-adblock)', group: 'ads', on: true, trusted: true,
      url: 'https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt', home: 'https://github.com/uBlockOrigin/uAssets' },
    { id: 'ubo-unbreak', cat: 'ads', name: 'uBlock unbreak', desc: 'Fixes sites broken by other lists', group: 'ads', on: true, trusted: true,
      url: 'https://ublockorigin.github.io/uAssets/filters/unbreak.txt', home: 'https://github.com/uBlockOrigin/uAssets' },
    { id: 'adguard-base', cat: 'ads', name: 'AdGuard Base', desc: 'AdGuard\'s ad list (without its EasyList copy)', group: 'ads', on: true, trusted: true,
      url: 'https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt', home: 'https://github.com/AdguardTeam/AdguardFilters' },
    { id: 'pgl', cat: 'ads', name: 'Peter Lowe\'s list', desc: 'Ad and tracking servers', group: 'ads', on: true,
      url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext', home: 'https://pgl.yoyo.org/adservers/' },

    // --- Privacy -----------------------------------------------------------
    { id: 'easyprivacy', cat: 'privacy', name: 'EasyPrivacy', desc: 'Trackers and analytics', group: 'ads', on: true,
      url: 'https://easylist.to/easylist/easyprivacy.txt', home: 'https://easylist.to/' },
    { id: 'ubo-privacy', cat: 'privacy', name: 'uBlock privacy', desc: 'Extra tracker blocking from uBlock Origin', group: 'ads', on: true, trusted: true,
      url: 'https://ublockorigin.github.io/uAssets/filters/privacy.txt', home: 'https://github.com/uBlockOrigin/uAssets' },
    { id: 'adguard-url-tracking', cat: 'privacy', name: 'AdGuard URL tracking', desc: 'Strips tracking parameters (fbclid, gclid, mc_eid, ...) from links', group: 'ads', on: true, trusted: true,
      url: 'https://filters.adtidy.org/extension/ublock/filters/17.txt', home: 'https://github.com/AdguardTeam/AdguardFilters' },

    { id: 'dxblock-strict', cat: 'privacy', name: 'dx.block strict', desc: 'Social SDKs, chat & push widgets, marketing and product analytics other lists allow. Turn off if a Facebook login, support chat or embed breaks', group: 'ads', on: true, trusted: true,
      url: 'local:tools/strict.txt', home: 'https://github.com/notdxbi/dxblock' },
    { id: 'hagezi-pro', cat: 'privacy', name: 'HaGeZi Multi PRO', desc: 'DNS-style blocklist: ads, trackers, telemetry, phishing (catches app/phone trackers EasyList misses)', group: 'ads', on: true,
      url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt', home: 'https://github.com/hagezi/dns-blocklists' },

    // --- Security ----------------------------------------------------------
    { id: 'ubo-badware', cat: 'security', name: 'uBlock badware risks', desc: 'Scam, fake-download and malware sites', group: 'ads', on: true, trusted: true,
      url: 'https://ublockorigin.github.io/uAssets/filters/badware.txt', home: 'https://github.com/uBlockOrigin/uAssets' },
    { id: 'urlhaus', cat: 'security', name: 'Malicious URL blocklist', desc: 'Active malware URLs (URLhaus)', group: 'ads', on: true,
      url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-ag-online.txt', home: 'https://gitlab.com/malware-filter/urlhaus-filter' },

    { id: 'phishing', cat: 'security', document: true, name: 'Phishing URL blocklist', desc: 'Active phishing sites (OpenPhish & PhishTank data)', group: 'ads', on: true,
      url: 'https://malware-filter.gitlab.io/malware-filter/phishing-filter-agh.txt', home: 'https://gitlab.com/malware-filter/phishing-filter' },

    // --- Annoyances (cookie banners + pop-up nags on; Fanboy's heavier list off) ---------------------------------------
    { id: 'ubo-cookies', cat: 'annoyances', name: 'uBlock cookie notices', desc: 'Hides cookie consent banners', group: 'annoyances', on: true, trusted: true,
      url: 'https://ublockorigin.github.io/uAssets/filters/annoyances-cookies.txt', home: 'https://github.com/uBlockOrigin/uAssets' },
    { id: 'ubo-annoyances', cat: 'annoyances', name: 'uBlock annoyances', desc: 'Pop-ups, "open in app" banners, newsletter nags', group: 'annoyances', on: true, trusted: true,
      url: 'https://ublockorigin.github.io/uAssets/filters/annoyances-others.txt', home: 'https://github.com/uBlockOrigin/uAssets' },
    { id: 'adguard-cookies', cat: 'annoyances', name: 'AdGuard cookie notices', desc: 'More cookie banners', group: 'annoyances', on: true, trusted: true,
      url: 'https://filters.adtidy.org/extension/ublock/filters/18.txt', home: 'https://github.com/AdguardTeam/AdguardFilters' },
    { id: 'fanboy-annoyance', cat: 'annoyances', name: 'Fanboy\'s Annoyance', desc: 'Social widgets, chat boxes and other clutter', group: 'annoyances', on: false,
      url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt', home: 'https://easylist.to/' }
];
