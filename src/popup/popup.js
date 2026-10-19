const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const state = await send({ type: 'popup:state', tabId: tab.id });

function render(s) {
    $('host').textContent = s.web ? s.host : 'This page can\'t be filtered';
    $('blocked').textContent = s.blocked.toLocaleString();
    $('power').checked = !s.disabled;
    $('power-title').textContent = s.disabled ? 'Protection off' : 'Protection on';
    $('power-sub').textContent = s.disabled ? 'Everything is allowed on this site' : 'Ads and trackers are blocked on this site';
    $('lists').textContent = `${s.lists} filter lists active`;
    document.body.classList.toggle('off', s.disabled);
    document.body.classList.toggle('na', !s.web);
}
render(state);

$('power').addEventListener('change', async (e) => {
    state.disabled = !e.target.checked;
    render(state);
    await send({ type: 'site:toggle', host: state.host, disabled: state.disabled });
    chrome.tabs.reload(tab.id);
    window.close();
});
$('pick').addEventListener('click', async () => {
    await send({ type: 'picker:start', tabId: tab.id });
    window.close();
});
$('settings').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
