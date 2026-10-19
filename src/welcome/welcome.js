const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

async function refresh() {
    const access = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }).catch(() => true);
    $('step-access').classList.toggle('done', access);
    $('grant').hidden = access;
    $('access-text').textContent = access ? 'dx.block can block ads on every website.' : 'Your browser asks you to confirm that dx.block may work on all websites. Without it nothing gets blocked.';
    const d = await send({ type: 'options:get' });
    if (d) {
        const filters = d.lists.filter((l) => d.enabled.includes(l.id)).reduce((n, l) => n + (l.filters || 0), 0);
        $('lists-text').textContent = `${d.enabled.length} filter lists active · ${filters.toLocaleString()} filters`;
        document.querySelectorAll('[data-tweak]').forEach((i) => { i.checked = !!d.tweaks[i.dataset.tweak]; });
    }
}
document.querySelectorAll('[data-tweak]').forEach((i) => i.addEventListener('change', () => send({ type: 'tweaks:set', tweaks: { [i.dataset.tweak]: i.checked } })));
$('grant').addEventListener('click', async () => {
    await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] }).catch(() => false);
    refresh();
});
$('done').addEventListener('click', () => window.close());
refresh();
