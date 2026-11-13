// Session-recording ("session replay") services: scripts that record your mouse, scrolling, clicks and typing
// so the site owner can watch your visit back like a video. dx.block blocks them and tells you who it was.
export const REPLAY = {
    'hotjar.com': 'Hotjar', 'hotjar.io': 'Hotjar',
    'fullstory.com': 'FullStory',
    'clarity.ms': 'Microsoft Clarity',
    'logrocket.io': 'LogRocket', 'logrocket.com': 'LogRocket', 'lr-ingest.io': 'LogRocket', 'lr-ingest.com': 'LogRocket', 'lr-in.com': 'LogRocket', 'lr-in-prod.com': 'LogRocket', 'lrkt-in.com': 'LogRocket',
    'mouseflow.com': 'Mouseflow',
    'smartlook.com': 'Smartlook', 'smartlook.cloud': 'Smartlook',
    'inspectlet.com': 'Inspectlet',
    'luckyorange.com': 'Lucky Orange', 'luckyorange.net': 'Lucky Orange',
    'sessioncam.com': 'SessionCam',
    'quantummetric.com': 'Quantum Metric',
    'contentsquare.net': 'Contentsquare', 'contentsquare.com': 'Contentsquare', 'clicktale.net': 'Contentsquare',
    'crazyegg.com': 'Crazy Egg',
    'glassboxdigital.io': 'Glassbox', 'glassbox.com': 'Glassbox',
    'decibelinsight.net': 'Decibel',
    'uxcam.com': 'UXCam', 'uxcam.io': 'UXCam',
    'sessionstack.com': 'SessionStack',
    'userzoom.com': 'UserZoom',
    'zipy.ai': 'Zipy',
    'openreplay.com': 'OpenReplay',
    'heap.io': 'Heap', 'heapanalytics.com': 'Heap',
    'yandex.ru/webvisor': 'Yandex Webvisor',
    'mc.yandex.ru': 'Yandex Webvisor', 'mc.yandex.com': 'Yandex Webvisor',
    'trymata.com': 'Trymata',
    'ptengine.com': 'Ptengine', 'ptengine.jp': 'Ptengine',
    'howuku.com': 'Howuku',
    'freshmarketer.com': 'Freshmarketer',
    'vwo.com': 'VWO Insights', 'visualwebsiteoptimizer.com': 'VWO Insights',
    'datadoghq-browser-agent.com': 'Datadog Session Replay',
    'browser-intake-datadoghq.com': 'Datadog Session Replay', 'browser-intake-datadoghq.eu': 'Datadog Session Replay',
    'noibu.com': 'Noibu',
    'posthog.com/s/': 'PostHog recordings'
};

// Domains only (the entries with a path are matched in replayOf)
export const REPLAY_DOMAINS = Object.keys(REPLAY).filter((d) => !d.includes('/'));

export function replayOf(host, url = '') {
    if (!host) return null;
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
        const d = parts.slice(i).join('.');
        if (REPLAY[d]) return REPLAY[d];
    }
    if (url && /posthog\.com\/s\//.test(url)) return REPLAY['posthog.com/s/'];
    return null;
}
