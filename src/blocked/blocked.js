const url = decodeURIComponent(location.hash.slice(1)) || (await chrome.runtime.sendMessage({ type: 'blocked:info' }))?.url || '';
document.getElementById('url').textContent = url || 'Unknown address';
document.getElementById('back').addEventListener('click', () => {
    if (history.length > 2) history.go(-2); else window.close();
});
document.getElementById('proceed').addEventListener('click', async () => {
    if (!url) return;
    await chrome.runtime.sendMessage({ type: 'blocked:proceed', url });
    location.replace(url);
});
