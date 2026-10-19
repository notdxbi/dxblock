const url = decodeURIComponent(location.hash.slice(1)) || (await chrome.runtime.sendMessage({ type: 'blocked:info' }))?.url || '';
document.getElementById('url').textContent = url || 'Unknown address';
const q = new URLSearchParams(location.search);
if (q.get('reason') === 'lookalike') {
    document.title = 'Possible fake site · dx.block';
    document.getElementById('title').textContent = `This may be a fake ${q.get('brand')[0].toUpperCase()}${q.get('brand').slice(1)} site`;
    document.getElementById('lead').textContent = `“${q.get('shown')}” looks like ${q.get('real')} but isn’t (${q.get('why')}). Fake sites like this steal passwords and card details. If you meant to visit ${q.get('real')}, type it yourself.`;
    const real = document.createElement('a');
    real.href = `https://${q.get('real')}/`;
    real.textContent = `Go to the real ${q.get('real')}`;
    real.className = 'real';
    document.querySelector('.actions').prepend(real);
}
document.getElementById('back').addEventListener('click', () => {
    if (history.length > 2) history.go(-2); else window.close();
});
document.getElementById('proceed').addEventListener('click', async () => {
    if (!url) return;
    if (q.get('reason') === 'lookalike') await chrome.runtime.sendMessage({ type: 'blocked:trust', url });
    else await chrome.runtime.sendMessage({ type: 'blocked:proceed', url });
    location.replace(url);
});
