// dx.block distractions: hides AI answers and sponsored results on search engines
// (Google AI Overviews and "AI Mode", Bing Copilot answers, DuckDuckGo Search Assist, Brave's AI answer).
(() => {
    if (window.__dxbNoAI || window.top !== window) return;
    window.__dxbNoAI = true;
    const css = document.createElement('style');
    css.textContent = `
        #tads, #tadsb, #bottomads, [data-text-ad], .commercial-unit-desktop-top, .commercial-unit-desktop-rhs, #atvcap,
        a[href*="udm=50"], div[role="listitem"]:has(> a[href*="udm=50"]),
        [data-dxb-ai],
        #b_copilot_answer, #b_copilotanswer, .b_ans:has(.b_cpfi), li.b_ad, .b_adTop, .b_adBottom,
        [data-testid="assist-answer"], [data-area="ai"], .ai-assist, [data-layout="ad"],
        #summarizer, .chatllm-container, #llm-snippet, .llm-snippet { display: none !important; }`;
    (document.head || document.documentElement).appendChild(css);

    // Google AI Overview has no stable id: find its heading and hide the block it heads
    const HEAD = /^(AI Overview|AI overview|Übersicht mit KI|Aperçu IA|Vista creada con IA|Resumen creado con IA|Panoramica IA|AI-overzicht|Visão geral criada por IA|Przegląd od AI|AI による概要|Обзор от ИИ)$/;
    function scan() {
        const root = document.getElementById('rcnt') || document.getElementById('center_col') || document.body;
        if (!root) return;
        for (const el of root.querySelectorAll('h1, h2, [role="heading"], strong, span')) {
            if (el.closest('[data-dxb-ai], a') || !HEAD.test((el.textContent || '').trim())) continue;
            let box = el;
            for (let i = 0; i < 14 && box.parentElement; i++) {
                const p = box.parentElement;
                if (p.id === 'rso' || p.id === 'center_col' || p.id === 'rcnt' || p.id === 'search' || p === document.body) break;
                box = p;
            }
            box.setAttribute('data-dxb-ai', '');
        }
    }
    let t = 0;
    const go = () => { clearTimeout(t); t = setTimeout(scan, 120); };
    new MutationObserver(go).observe(document.documentElement, { childList: true, subtree: true });
    go();
})();
