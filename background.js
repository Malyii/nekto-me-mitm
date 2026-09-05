const CONTROL_PAGE = 'control.html';
const CONTROL_PORT = 'nekto-control';
const AUDIO_BRIDGE_ENABLED = true;
const MANAGED_TAB_LIMIT = 2;
const NEKTO_URL = 'https://nekto.me/audiochat';
const NEKTO_URL_PATTERNS = ['*://nekto.me/*', '*://*.nekto.me/*'];
const ALLOWED_ACTIONS = new Set(['NEXT', 'STOP']);
const ALLOWED_STATUSES = new Set(['CONNECTED', 'DISCONNECTED']);

const managedTabIds = new Set();
let controlConnection = null;

chrome.action.onClicked.addListener(() => {
    void focusOrOpenControlPanel();
});

chrome.runtime.onConnect.addListener((port) => {
    if (!isControlConnection(port)) {
        port.disconnect();
        return;
    }

    controlConnection?.disconnect();
    controlConnection = port;

    port.onMessage.addListener(handleControlMessage);
    port.onDisconnect.addListener(() => {
        if (controlConnection === port) controlConnection = null;
    });

    void discoverManagedTabs();
});

chrome.runtime.onMessage.addListener((message, sender) => {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId) || sender.frameId !== 0 || !isNektoUrl(sender.url)) return;

    if (message.type === 'REGISTER_TAB') {
        registerManagedTab(tabId);
        return;
    }
    if (!managedTabIds.has(tabId)) return;

    switch (message.type) {
        case 'AUDIO_TRACK_READY':
            if (AUDIO_BRIDGE_ENABLED) postToControl({ type: message.type, tabId, senderTabId: tabId });
            break;

        case 'AUDIO_TRACK_SIGNAL':
            if (AUDIO_BRIDGE_ENABLED && message.signal && typeof message.signal === 'object') {
                postToControl({ type: message.type, tabId, senderTabId: tabId, signal: message.signal });
            }
            break;

        case 'STRANGER_STATUS':
            if (ALLOWED_STATUSES.has(message.status)) {
                postToControl({ type: message.type, tabId, status: message.status });
            }
            break;

        case 'CALL_TIME':
            if (typeof message.time === 'string') {
                postToControl({ type: message.type, tabId, time: message.time.slice(0, 16) });
            }
            break;

        case 'CAPTCHA_REQUIRED':
        case 'CAPTCHA_CLEARED':
            postToControl({ type: message.type, tabId, round: message.round });
            break;
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (!managedTabIds.delete(tabId)) return;
    postToControl({ type: 'TAB_CLOSED', tabId });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url || !managedTabIds.has(tabId) || isNektoUrl(changeInfo.url)) return;
    managedTabIds.delete(tabId);
    postToControl({ type: 'TAB_CLOSED', tabId });
});

async function focusOrOpenControlPanel() {
    const controlUrl = chrome.runtime.getURL(CONTROL_PAGE);
    const tabs = await chrome.tabs.query({});
    const existingTab = tabs.find((tab) => tab.url === controlUrl);

    if (existingTab?.id) {
        await chrome.tabs.update(existingTab.id, { active: true });
        return;
    }

    await chrome.tabs.create({ url: controlUrl });
}

function isControlConnection(port) {
    return port.name === CONTROL_PORT && port.sender?.url === chrome.runtime.getURL(CONTROL_PAGE);
}

function isNektoUrl(url) {
    if (!url) return false;

    try {
        const { hostname } = new URL(url);
        return hostname === 'nekto.me' || hostname.endsWith('.nekto.me');
    } catch {
        return false;
    }
}

async function discoverManagedTabs() {
    const tabs = await chrome.tabs.query({ url: NEKTO_URL_PATTERNS });

    if (tabs.length === 0) {
        await createDefaultTabs();
        return;
    }

    for (const tab of tabs) {
        if (Number.isInteger(tab.id)) registerManagedTab(tab.id);
    }
}

function registerManagedTab(tabId) {
    if (!managedTabIds.has(tabId) && managedTabIds.size >= MANAGED_TAB_LIMIT) return false;

    managedTabIds.add(tabId);
    void chrome.tabs.update(tabId, { muted: true }).catch(() => {});
    postToControl({ type: 'TAB_REGISTERED', tabId });
    return true;
}

function handleControlMessage(message) {
    switch (message.type) {
        case 'ACTION':
            if (managedTabIds.has(message.targetTabId) && ALLOWED_ACTIONS.has(message.action)) {
                sendToTab(message.targetTabId, message);
            }
            break;

        case 'AUDIO_TRACK_REQUEST':
            if (AUDIO_BRIDGE_ENABLED && managedTabIds.has(message.targetTabId)) {
                sendToTab(message.targetTabId, { type: message.type });
            }
            break;

        case 'AUDIO_TRACK_SIGNAL':
            if (AUDIO_BRIDGE_ENABLED && managedTabIds.has(message.targetTabId)) {
                sendToTab(message.targetTabId, {
                    type: message.type,
                    signal: message.signal
                });
            }
            break;

        case 'SET_TAB_MUTED':
            if (managedTabIds.has(message.targetTabId) && typeof message.muted === 'boolean') {
                void chrome.tabs.update(message.targetTabId, { muted: message.muted }).catch(() => {});
            }
            break;

        case 'CLOSE_TABS':
            void closeManagedTabs();
            break;
    }
}

async function createDefaultTabs() {
    for (let index = 0; index < MANAGED_TAB_LIMIT; index += 1) {
        await chrome.tabs.create({ url: NEKTO_URL, active: false });
    }
}

async function closeManagedTabs() {
    const tabIds = [...managedTabIds];
    if (tabIds.length > 0) await chrome.tabs.remove(tabIds);
}

function postToControl(message) {
    try {
        controlConnection?.postMessage(message);
    } catch {
        controlConnection = null;
    }
}

function sendToTab(tabId, message) {
    void chrome.tabs.sendMessage(tabId, message).catch(() => {});
}
