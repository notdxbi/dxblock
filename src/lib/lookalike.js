// Fake-site detection: hostnames that imitate a well-known brand (paypa1.com, раypal.com, paypal.com.verify-account.xyz).
const BRANDS = {
    paypal: 'paypal.com', google: 'google.com', gmail: 'gmail.com', youtube: 'youtube.com', apple: 'apple.com', icloud: 'icloud.com',
    microsoft: 'microsoft.com', outlook: 'outlook.com', office: 'office.com', live: 'live.com', amazon: 'amazon.com', facebook: 'facebook.com',
    instagram: 'instagram.com', whatsapp: 'whatsapp.com', netflix: 'netflix.com', spotify: 'spotify.com', twitter: 'twitter.com',
    linkedin: 'linkedin.com', github: 'github.com', dropbox: 'dropbox.com', steam: 'steampowered.com', steamcommunity: 'steamcommunity.com',
    discord: 'discord.com', roblox: 'roblox.com', epicgames: 'epicgames.com', coinbase: 'coinbase.com', binance: 'binance.com',
    kraken: 'kraken.com', metamask: 'metamask.io', blockchain: 'blockchain.com', ebay: 'ebay.com', walmart: 'walmart.com',
    chase: 'chase.com', wellsfargo: 'wellsfargo.com', bankofamerica: 'bankofamerica.com', citibank: 'citibank.com', hsbc: 'hsbc.com',
    barclays: 'barclays.co.uk', lloydsbank: 'lloydsbank.com', natwest: 'natwest.com', santander: 'santander.com', revolut: 'revolut.com',
    monzo: 'monzo.com', venmo: 'venmo.com', cashapp: 'cash.app', stripe: 'stripe.com', dhl: 'dhl.com', fedex: 'fedex.com', ups: 'ups.com',
    usps: 'usps.com', royalmail: 'royalmail.com', adobe: 'adobe.com', yahoo: 'yahoo.com', telegram: 'telegram.org', tiktok: 'tiktok.com',
    snapchat: 'snapchat.com', reddit: 'reddit.com', twitch: 'twitch.tv', blizzard: 'blizzard.com', battlenet: 'battle.net', xbox: 'xbox.com',
    playstation: 'playstation.com', nintendo: 'nintendo.com', booking: 'booking.com', airbnb: 'airbnb.com', docusign: 'docusign.com',
    wetransfer: 'wetransfer.com', zoom: 'zoom.us', okta: 'okta.com', proton: 'proton.me', protonmail: 'protonmail.com'
};
// Characters people (and scammers) confuse, including Cyrillic/Greek look-alikes
const CONFUSE = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's',
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ԁ': 'd', 'ɡ': 'g', 'ո': 'n', 'ս': 'u',
    'ν': 'v', 'ο': 'o', 'α': 'a', 'ρ': 'p', 'τ': 't', 'κ': 'k', 'ι': 'i', 'ӏ': 'l', 'ⅼ': 'l', 'ı': 'i', 'ɩ': 'i' };
const skeleton = (s) => [...s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()].map((c) => CONFUSE[c] || c).join('')
    .replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd').replace(/-/g, '').replace(/[il|]/g, 'l');

function registrable(host) {
    const p = host.split('.');
    if (p.length > 2 && p[p.length - 1].length === 2 && /^(co|com|net|org|gov|ac)$/.test(p[p.length - 2])) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
}
const owns = (host, real) => host === real || host.endsWith(`.${real}`);
const anyOfficial = (host) => Object.values(BRANDS).some((d) => owns(host, d) || owns(host, d.replace(/\.(com|co\.uk|io|tv|org|me|us|net|app)$/, '')));

// Returns { brand, real, reason } when `hostname` (punycode-decoded) imitates a brand; null otherwise.
export function lookalike(hostname, unicodeHost = hostname) {
    if (!hostname || anyOfficial(hostname)) return null;
    const reg = registrable(unicodeHost);
    const label = reg.split('.')[0];
    const sk = skeleton(label);
    for (const [brand, real] of Object.entries(BRANDS)) {
        if (owns(hostname, real)) return null;
        if (brand.length < 5) continue;                                       // short names collide too often
        const b = skeleton(brand);
        if (sk === b && label !== brand) return { brand, real, reason: 'look-alike characters' };
        if (label !== brand && [...['login', 'secure', 'support', 'verify', 'account', 'wallet', 'gift', 'gifts', 'free', 'nitro', 'help', 'security'].map((x) => brand + x), `secure${brand}`, `my${brand}`].map(skeleton).includes(sk)) {
            return { brand, real, reason: 'brand name in a different domain' };
        }
    }
    // paypal.com.account-verify.xyz : a brand's real domain used as a subdomain of something else
    for (const [brand, real] of Object.entries(BRANDS)) {
        if (hostname.includes(`${real}.`) && !owns(hostname, real)) return { brand, real, reason: `${real} used as a disguise` };
    }
    return null;
}

// Punycode (RFC 3492) decoding so "xn--pypal-4ve.com" can be checked as "pаypal.com"
function decodeLabel(input) {
    const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
    let n = 128, i = 0, bias = 72;
    const out = [];
    let b = input.lastIndexOf('-');
    if (b < 0) b = 0;
    for (let j = 0; j < b; j++) out.push(input.charCodeAt(j));
    const adapt = (delta, numPoints, first) => {
        delta = first ? Math.floor(delta / damp) : delta >> 1;
        delta += Math.floor(delta / numPoints);
        let k = 0;
        for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
        return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
    };
    for (let idx = b > 0 ? b + 1 : 0; idx < input.length;) {
        const oldi = i;
        for (let w = 1, k = base; ; k += base) {
            const c = input.charCodeAt(idx++);
            const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
            i += digit * w;
            const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
            if (digit < t) break;
            w *= base - t;
        }
        bias = adapt(i - oldi, out.length + 1, oldi === 0);
        n += Math.floor(i / (out.length + 1));
        i %= out.length + 1;
        out.splice(i++, 0, n);
    }
    return String.fromCodePoint(...out);
}
export function toUnicode(host) {
    try { return host.split('.').map((l) => (l.startsWith('xn--') ? decodeLabel(l.slice(4)) : l)).join('.'); } catch { return host; }
}
