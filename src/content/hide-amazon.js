// dx.block distractions: removes sponsored products and ad slots on Amazon search results and product pages.
(() => {
    if (window.__dxbNoAmzn) return;
    window.__dxbNoAmzn = true;
    const css = document.createElement('style');
    css.textContent = `
        div[data-component-type="sp-sponsored-result"], .s-result-item:has(.puis-sponsored-label-text), .s-result-item:has(.s-sponsored-label-text),
        .AdHolder, [cel_widget_id*="sponsored" i], [data-cel-widget*="sp_detail"], #sp_detail, #sp_detail2, #sp_detail_thematic,
        [data-cel-widget*="adplacements"], [id^="ape_"][id$="_placement"], .sbv-video-single-product, [data-cel-widget^="MAIN-VIDEO_SINGLE_PRODUCT"],
        [data-cel-widget^="MAIN-SHOPPING_ADVISER"], [data-component-type="s-ads-metrics"], .s-result-item:has([data-component-type="sbv-video-single-product"]),
        #percolate-ui-ilm_div, #amsDetailRight_feature_div, #sims-consolidated-1_feature_div:has(.sp_desktop_sponsored_label) { display: none !important; }`;
    (document.head || document.documentElement).appendChild(css);
})();
