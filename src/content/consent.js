// dx.block cookie banners: presses "Reject all" for you instead of only hiding the banner, so the site
// records that you said no. Known consent tools first (exact buttons), then a careful generic match.
(() => {
    if (window.__dxbConsent) return;
    window.__dxbConsent = true;

    // [banner present, reject button] pairs for the big consent platforms
    const KNOWN = [
        ['#onetrust-banner-sdk, #onetrust-consent-sdk', '#onetrust-reject-all-handler, .ot-pc-refuse-all-handler'],
        ['#CybotCookiebotDialog', '#CybotCookiebotDialogBodyButtonDecline, #CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll'],
        ['.qc-cmp2-container', '.qc-cmp2-summary-buttons button[mode="secondary"], button.qc-cmp2-reject-all'],
        ['#didomi-host', '#didomi-notice-disagree-button, .didomi-continue-without-agreeing'],
        ['.fc-consent-root', '.fc-cta-do-not-consent, .fc-button.fc-cta-do-not-consent'],
        ['#usercentrics-root, #usercentrics-cmp-ui', '[data-testid="uc-deny-all-button"], button.uc-deny-button'],
        ['.cky-consent-container', '.cky-btn-reject'],
        ['.cmplz-cookiebanner', '.cmplz-btn.cmplz-deny'],
        ['.osano-cm-window', '.osano-cm-denyAll, .osano-cm-button--type_denyAll'],
        ['#iubenda-cs-banner', '.iubenda-cs-reject-btn'],
        ['.klaro', '.cm-btn-decline, .cn-decline'],
        ['[data-tid="banner-decline"]', '[data-tid="banner-decline"]'],
        ['#axeptio_overlay', '#axeptio_btn_dismiss'],
        ['#cmpbox', '.cmpboxbtnno, a.cmpboxbtn.cmpboxbtnno'],
        ['#BorlabsCookieBox', '#BorlabsCookieBox a[data-cookie-refuse], .brlbs-btn-accept-only-essential'],
        ['#truste-consent-track, #truste-consent-content', '#truste-consent-required'],
        ['#cookiescript_injected', '#cookiescript_reject'],
        ['.cc-window, .cc-banner', '.cc-deny, .cc-dismiss.cc-deny'],
        ['#ccc', '#ccc-reject-settings, #ccc-notify-reject'],
        ['#cookie-law-info-bar', '#cookie_action_close_header_reject, .cky-btn-reject'],
        ['#moove_gdpr_cookie_info_bar', '.moove-gdpr-infobar-reject-btn'],
        ['#hs-eu-cookie-confirmation', '#hs-eu-decline-button'],
        ['#gdpr-consent-tool-wrapper, #sp_message_container', 'button[title="Reject All"], button[title="Reject all"], button.sp_choice_type_13'],
        ['ketch-consent, #lanyard_root', '#ketch-banner-button-secondary, button[aria-label="Reject All"]'],
        ['.tarteaucitronAlertBigTop, #tarteaucitronRoot', '#tarteaucitronAllDenied2, .tarteaucitronDeny'],
        ['#consent_blackbar, .truste_box_overlay', '.pdynamicbutton .required, #truste-consent-required'],
        ['[aria-label="Before you continue to Google"], form[action*="consent.google"], form[action*="consent.youtube"]', 'form[action*="consent"] button[aria-label^="Reject"]'],
        ['ytd-consent-bump-v2-lightbox, tp-yt-paper-dialog #lightbox', 'ytd-consent-bump-v2-lightbox button[aria-label^="Reject"]'],
        ['[data-testid="cookie-policy-manage-dialog"], [data-cookiebanner]', '[data-cookiebanner="accept_only_essential_button"], [data-testid="cookie-policy-manage-dialog-decline-button"]'],
        ['#gdpr-banner, .gdpr-banner', '#gdpr-banner-decline, .gdpr-banner__decline']
    ];

    // Generic: a visible box about cookies / consent with one clearly "reject" button
    const REJECT = /^\s*(reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?|refuse( all)?|disagree|do not (accept|consent)|don['’]t (accept|allow)|no,? thanks|only (strictly )?(necessary|essential|required)( cookies)?|(use )?(strictly )?(necessary|essential|required) (cookies )?only|continue without (accepting|agreeing)|alle ablehnen|ablehnen|nur (notwendige|essenzielle)( cookies)?|tout refuser|refuser( tout)?|continuer sans accepter|rechazar( todo| todas)?|rifiuta( tutto)?|weigeren|alles weigeren|odrzuć( wszystkie)?|recusar( tudo)?|avvisa alla|afvis alle|hylkää( kaikki)?|avslå( alle)?)\s*[.!]?\s*$/i;
    const COOKIE_WORDS = /cookie|consent|privacy|gdpr|tracking|datenschutz|confidentialité|privacidad|personal data|partners/i;

    const visible = (el) => {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    };
    // A banner hidden by our own cosmetic filters is display:none, so for the known tools don't require visibility:
    // pressing the button is still what records "no"
    let done = false;
    let tries = 0;

    function click(btn, how) {
        if (done || !btn) return false;
        done = true;
        try { btn.click(); } catch { return false; }
        chrome.runtime.sendMessage({ type: 'guard:event', kind: 'consent', detail: how }).catch(() => null);
        return true;
    }

    function deepQuery(root, sel) {
        const hit = root.querySelector(sel);
        if (hit) return hit;
        // Usercentrics and a few others live in an open shadow root
        for (const host of root.querySelectorAll('#usercentrics-root, #usercentrics-cmp-ui, aside#usercentrics-cmp-ui, [id*="consent" i]')) {
            if (host.shadowRoot) { const x = host.shadowRoot.querySelector(sel); if (x) return x; }
        }
        return null;
    }

    function tryKnown() {
        for (const [banner, button] of KNOWN) {
            if (!deepQuery(document, banner)) continue;
            const btn = deepQuery(document, button);
            if (btn && click(btn, 'known')) return true;
        }
        return false;
    }

    function tryGeneric() {
        const boxes = document.querySelectorAll('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [aria-label*="cookie" i], [role="dialog"], [role="alertdialog"]');
        for (const box of boxes) {
            if (box === document.body || box === document.documentElement) continue;
            if (!COOKIE_WORDS.test((box.textContent || '').slice(0, 3000))) continue;
            const buttons = [...box.querySelectorAll('button, [role="button"], a[href="#"], a:not([href]), input[type="button"], input[type="submit"]')]
                .filter((b) => REJECT.test(b.innerText || b.value || b.getAttribute('aria-label') || ''));
            if (buttons.length !== 1 || !visible(buttons[0])) continue;
            if (click(buttons[0], 'generic')) return true;
        }
        return false;
    }

    function run() {
        if (done || ++tries > 40) return stop();
        if (tryKnown() || tryGeneric()) stop();
    }
    let mo = null;
    let timer = 0;
    function stop() { mo?.disconnect(); clearTimeout(timer); }

    chrome.runtime.sendMessage({ type: 'guard:init' }).then((cfg) => {
        if (!cfg || cfg.off) return;
        const start = () => {
            run();
            if (done) return;
            mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(run, 250); });
            mo.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(stop, 20_000);          // banners appear early; don't watch the page forever
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
    }).catch(() => null);
})();
