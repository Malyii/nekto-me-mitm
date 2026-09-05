const NAMESPACE = '__nk_bridge__';

try {
    void chrome.runtime.sendMessage({ type: 'REGISTER_TAB' }).catch(() => {});
} catch {}

window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.ns !== NAMESPACE || event.data.dir !== 'UP') return;

    try {
        void chrome.runtime.sendMessage(event.data.payload).catch(() => {});
    } catch {}
}, true);

chrome.runtime.onMessage.addListener((message) => {
    window.postMessage({ ns: NAMESPACE, dir: 'DOWN', payload: message }, location.origin);
});
