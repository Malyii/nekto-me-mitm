import { PairedAudioRouter } from './modules/audio-router.js';

const AUDIO_BRIDGE_ENABLED = true;
const TAB_LIMIT = 2;
const tabCards = new Map();
const UI_TEXT = {
    headerMicOffTooltip: 'Microphone is off — click to enable',
    headerMicOnTooltip: 'Microphone is on — click to disable',
    headerMicRequestTooltip: 'Requesting microphone access...',
    headerMicErrorTooltip: 'Microphone is unavailable — click to retry',
    tabIdle: 'Idle',
    tabSearching: 'Searching',
    tabConnected: 'Chatting',
    btnStop: 'STOP',
    btnNext: 'SKIP',
    btnStopTooltip: 'Stop dialog',
    btnNextTooltip: 'Next partner',
    btnSpeakerMuteTooltip: 'Mute this participant for everyone',
    btnSpeakerUnmuteTooltip: 'Unmute this participant for everyone',
    captchaTitle: 'CAPTCHA REQUIRED',
    captchaSolveHint: 'Click to solve',
    spLoading: 'Loading library...',
    spNotFound: 'No sounds found.',
    spError: 'API Error. Check internet connection.'
};

let controlPort = null;
let reconnectTimer = null;

function postToBackground(message) {
    try {
        controlPort?.postMessage(message);
    } catch (_) {}
}

const audioRouter = AUDIO_BRIDGE_ENABLED
    ? new PairedAudioRouter({
        sendSignal(tabId, signal) {
            postToBackground({
                type: 'AUDIO_TRACK_SIGNAL',
                targetTabId: tabId,
                signal
            });
        },
        onMonitorState(tabId, _available) {
            postToBackground({
                type: 'SET_TAB_MUTED',
                targetTabId: tabId,
                muted: true
            });
        },
        onVoiceActivity(tabId, isSpeaking) {
            const card = tabCards.get(tabId);
            if (!card) return;
            card.classList.toggle('voice-active', Boolean(isSpeaking));
        }
    })
    : null;

function connectToBackground() {
    clearTimeout(reconnectTimer);
    controlPort = chrome.runtime.connect({ name: 'nekto-control' });
    controlPort.onMessage.addListener(handleBackgroundMessage);
    controlPort.onDisconnect.addListener(() => {
        controlPort = null;
        for (const tabId of tabCards.keys()) audioRouter?.close(tabId);
        reconnectTimer = setTimeout(connectToBackground, 500);
    });
}

window.addEventListener('beforeunload', () => {
    clearTimeout(reconnectTimer);
    audioRouter?.dispose();
    controlPort?.disconnect();
});
window.addEventListener('pointerdown', () => audioRouter?.resume(), { passive: true });
window.addEventListener('keydown', () => audioRouter?.resume(), { passive: true });

const tabGrid = document.getElementById('tabGrid');
const emptyState = document.getElementById('emptyState');
const headerStartAllBtn = document.getElementById('headerStartAllBtn');
const headerStopAllBtn = document.getElementById('headerStopAllBtn');
const headerCloseAllBtn = document.getElementById('headerCloseAllBtn');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const toggleSoundpadBtn = document.getElementById('toggleSoundpadBtn');
const soundpadPanel = document.getElementById('soundpadPanel');

let microphoneTrack = null;
let microphoneRequestInFlight = false;
let microphoneHasError = false;

function updateMicrophoneButton() {
    if (!toggleMicBtn) return;

    const t = UI_TEXT;
    const enabled = microphoneTrack?.readyState === 'live';
    const tooltip = microphoneRequestInFlight
        ? t.headerMicRequestTooltip
        : enabled
            ? t.headerMicOnTooltip
            : microphoneHasError
                ? t.headerMicErrorTooltip
                : t.headerMicOffTooltip;

    toggleMicBtn.classList.toggle('active', enabled);
    toggleMicBtn.disabled = microphoneRequestInFlight;
    toggleMicBtn.dataset.tooltip = tooltip;
    toggleMicBtn.setAttribute('aria-label', tooltip);
    toggleMicBtn.setAttribute('aria-pressed', String(enabled));
    toggleMicBtn.setAttribute('aria-busy', String(microphoneRequestInFlight));
}

function disableMicrophone() {
    microphoneTrack = null;
    microphoneHasError = false;
    audioRouter?.clearMicrophoneTrack();
    updateMicrophoneButton();
}

async function enableMicrophone() {
    if (microphoneRequestInFlight) return;

    microphoneRequestInFlight = true;
    microphoneHasError = false;
    updateMicrophoneButton();
    let capturedTrack = null;

    try {
        if (!audioRouter) throw new Error('Audio router is unavailable');
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('Microphone capture is unavailable');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });
        const [track] = stream.getAudioTracks();
        capturedTrack = track || null;

        if (!track) {
            for (const streamTrack of stream.getTracks()) streamTrack.stop();
            throw new Error('The selected device did not provide an audio track');
        }

        for (const streamTrack of stream.getTracks()) {
            if (streamTrack !== track) streamTrack.stop();
        }
        try { track.contentHint = 'speech'; } catch (_) {}

        audioRouter.setMicrophoneTrack(track);
        microphoneTrack = track;
        track.addEventListener('ended', () => {
            if (microphoneTrack !== track) return;
            microphoneTrack = null;
            microphoneHasError = true;
            audioRouter.clearMicrophoneTrack(false);
            updateMicrophoneButton();
        }, { once: true });
    } catch (_) {
        if (capturedTrack?.readyState === 'live') capturedTrack.stop();
        microphoneTrack = null;
        microphoneHasError = true;
        audioRouter?.clearMicrophoneTrack();
    } finally {
        microphoneRequestInFlight = false;
        updateMicrophoneButton();
    }
}

toggleMicBtn?.addEventListener('click', () => {
    if (microphoneTrack?.readyState === 'live') {
        disableMicrophone();
        return;
    }
    void enableMicrophone();
});

updateMicrophoneButton();

function updateSpeakerButton(button) {
    if (!button) return;

    const t = UI_TEXT;
    const muted = button.classList.contains('muted');
    const tooltip = muted
        ? t.btnSpeakerUnmuteTooltip
        : t.btnSpeakerMuteTooltip;

    button.dataset.tooltip = tooltip;
    button.setAttribute('aria-label', tooltip);
    button.setAttribute('aria-pressed', String(muted));
}

function createTabCard(tabId) {
    const card = document.createElement('div');
    card.className = 'tab-card';
    card.id = `tab-card-${tabId}`;
    card.dataset.tabId = tabId;

    const t = UI_TEXT;
    card.innerHTML = `
        <div class="tab-card-header">
            <div class="tab-title-group">
                <div class="pulse-dot"></div>
                <span class="tab-card-title">#${tabCards.size + 1}</span>
            </div>
            <span class="tab-status idle">${t.tabIdle}</span>
        </div>
        <div class="tab-body">
            <div class="tab-time">00:00</div>
        </div>
        <button class="tab-captcha-overlay" type="button" aria-label="${t.captchaTitle}">
            <span class="captcha-badge">
                <svg class="captcha-icon" viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                    <path d="M9 12l2 2 4-4"></path>
                </svg>
                <span class="captcha-title">${t.captchaTitle}</span>
                <span class="captcha-sub">${t.captchaSolveHint}</span>
            </span>
        </button>
        <div class="tab-actions">
            <button class="btn-speaker" type="button" data-tooltip="${t.btnSpeakerMuteTooltip}" aria-label="${t.btnSpeakerMuteTooltip}" aria-pressed="false">
                <svg class="icon-speaker-on" viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <path class="speaker-waves" d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>
                <svg class="icon-speaker-off" viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <line x1="23" y1="9" x2="17" y2="15"></line>
                    <line x1="17" y1="9" x2="23" y2="15"></line>
                </svg>
            </button>
            <button class="btn-stop" type="button" data-tooltip="${t.btnStopTooltip}"><span>${t.btnStop}</span></button>
            <button class="btn-next" type="button" data-tooltip="${t.btnNextTooltip}"><span>${t.btnNext}</span> <span aria-hidden="true">&rarr;</span></button>
        </div>
    `;

    card.querySelector('.btn-speaker')?.addEventListener('click', (e) => {
        const button = e.currentTarget;
        const muted = button.classList.toggle('muted');
        updateSpeakerButton(button);
        audioRouter?.setInputMuted(tabId, muted);
    });
    card.querySelector('.btn-next').addEventListener('click', () => {
        sendAction(tabId, 'NEXT');
    });
    card.querySelector('.btn-stop').addEventListener('click', () => sendAction(tabId, 'STOP'));

    const captchaOverlay = card.querySelector('.tab-captcha-overlay');
    captchaOverlay?.addEventListener('click', () => {
        chrome.tabs.update(tabId, { active: true }).catch(() => {});
    });

    tabGrid.appendChild(card);
    tabCards.set(tabId, card);
    updateTabNumbers();
    updateEmptyState();
    updateTabOrder();
}

function removeTabCard(tabId) {
    const card = tabCards.get(tabId);
    if (!card) return;
    card.remove();
    tabCards.delete(tabId);
    updateTabNumbers();
    updateEmptyState();
    updateTabOrder();
}

function updateTabNumbers() {
    let index = 1;
    for (const [, card] of tabCards) {
        const titleEl = card.querySelector('.tab-card-title');
        if (titleEl) titleEl.textContent = `#${index}`;
        index++;
    }
}

function updateTabOrder() {
    audioRouter?.setTabOrder([...tabCards.keys()]);
}

function updateEmptyState() {
    if (!emptyState || !tabGrid) return;
    emptyState.style.display = tabCards.size === 0 ? 'flex' : 'none';
    tabGrid.style.display = tabCards.size > 0 ? 'grid' : 'none';
}
updateEmptyState();

function updateTabStatus(tabId, status) {
    const card = tabCards.get(tabId);
    if (!card) return;
    const statusEl = card.querySelector('.tab-status');
    statusEl.className = 'tab-status ' + status.toLowerCase();
    const t = UI_TEXT;
    const labels = {
        idle: t.tabIdle,
        searching: t.tabSearching,
        connected: t.tabConnected
    };
    statusEl.textContent = labels[status.toLowerCase()] || status;

    card.dataset.status = status;
    card.classList.toggle('connected', status === 'CONNECTED');
    card.classList.toggle('searching', status === 'SEARCHING');

    if (status !== 'CONNECTED') {
        card.classList.remove('voice-active');
    }
}

function updateTabTime(tabId, time) {
    const card = tabCards.get(tabId);
    if (!card) return;
    card.querySelector('.tab-time').textContent = time || '00:00';
}

function sendAction(tabId, action) {
    postToBackground({ type: 'ACTION', targetTabId: tabId, action });
    if (action === 'STOP') {
        updateTabStatus(tabId, 'IDLE');
    } else {
        updateTabStatus(tabId, 'SEARCHING');
        updateTabTime(tabId, '00:00');
    }
}

const triggerStartAll = () => {
    for (const [tabId] of tabCards) sendAction(tabId, 'NEXT');
};

const triggerStopAll = () => {
    for (const [tabId] of tabCards) sendAction(tabId, 'STOP');
};

const triggerCloseAll = () => {
    postToBackground({ type: 'CLOSE_TABS' });
};

headerStartAllBtn?.addEventListener('click', triggerStartAll);
headerStopAllBtn?.addEventListener('click', triggerStopAll);
headerCloseAllBtn?.addEventListener('click', triggerCloseAll);

let soundpadFavs = JSON.parse(localStorage.getItem('soundpadFavs') || '[]');
let soundpadRecent = JSON.parse(localStorage.getItem('soundpadRecent') || '[]');
let currentSoundpadAudio = null;
let playerRaf = null;
let isDraggingSeek = false;

let soundpadLibrary = [];
let soundpadPage = 0;
const SP_PAGE_SIZE = 14;
let currentSoundpadTab = 'search';
let currentSoundpadQuery = '';
let currentSoundpadOffset = 0;
let isFetchingSoundpad = false;
let soundpadInitialized = false;

const spGrid = document.getElementById('sp-grid');
const spTitle = document.getElementById('sp-now-title');
const spTimeCurr = document.getElementById('sp-time-curr');
const spTimeDur = document.getElementById('sp-time-dur');
const spSeek = document.getElementById('sp-seek');
const spPauseBtn = document.getElementById('sp-pause');
const spSearchInput = document.getElementById('sp-search-input');
const spPeerVolInput = document.getElementById('sp-volume-peer');
const spMonitorVolInput = document.getElementById('sp-volume-monitor');
const spBtnPrev = document.getElementById('sp-page-prev');
const spBtnNext = document.getElementById('sp-page-next');
const spBtnLoadMore = document.getElementById('sp-load-more');

function formatTime(sec) {
    if (isNaN(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function updatePlayerUI() {
    if (!currentSoundpadAudio) return;
    const curr = currentSoundpadAudio.currentTime || 0;
    const dur = currentSoundpadAudio.duration || 0;

    if (spTimeCurr) spTimeCurr.textContent = formatTime(curr);
    if (spTimeDur) spTimeDur.textContent = formatTime(dur);

    if (dur > 0 && !isDraggingSeek && spSeek) {
        spSeek.value = (curr / dur) * 1000;
    }

    playerRaf = requestAnimationFrame(updatePlayerUI);
}

if (spSeek) {
    spSeek.addEventListener('mousedown', () => { isDraggingSeek = true; });
    spSeek.addEventListener('mouseup', () => { isDraggingSeek = false; });
    spSeek.addEventListener('input', (e) => {
        if (!currentSoundpadAudio || !currentSoundpadAudio.duration) return;
        const val = parseFloat(e.target.value) / 1000;
        currentSoundpadAudio.currentTime = val * currentSoundpadAudio.duration;
    });
}

function togglePauseIcon(isPlaying) {
    const playIcon = spPauseBtn?.querySelector('.icon-play');
    const pauseIcon = spPauseBtn?.querySelector('.icon-pause');
    if (playIcon && pauseIcon) {
        playIcon.style.display = isPlaying ? 'none' : 'block';
        pauseIcon.style.display = isPlaying ? 'block' : 'none';
    }
}

if (spPauseBtn) {
    spPauseBtn.addEventListener('click', () => {
        if (!currentSoundpadAudio) return;
        if (currentSoundpadAudio.paused) {
            audioRouter?.resume();
            currentSoundpadAudio.play().then(() => {
                togglePauseIcon(true);
                playerRaf = requestAnimationFrame(updatePlayerUI);
            }).catch(() => {});
        } else {
            currentSoundpadAudio.pause();
            togglePauseIcon(false);
            if (playerRaf) cancelAnimationFrame(playerRaf);
        }
    });
}

async function loadSoundpad(query = '', append = false) {
    if (!spGrid) return;
    const t = UI_TEXT;

    if (!append) {
        spGrid.innerHTML = `<div class="sp-loading">${t.spLoading}</div>`;
        currentSoundpadOffset = 0;
        soundpadLibrary = [];
        soundpadPage = 0;
    }
    if (isFetchingSoundpad) return;
    isFetchingSoundpad = true;

    try {
        const url = query.trim()
            ? `https://uwupad.me/api/search?v3=true&query=${encodeURIComponent(query)}&limit=30&offset=${currentSoundpadOffset}`
            : `https://uwupad.me/api/sounds?v3=true&tab=newest&limit=30&offset=${currentSoundpadOffset}`;

        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error('Failed to fetch sounds');
        const json = await res.json();
        const items = json.items || json.data || [];

        if (append) {
            soundpadLibrary = soundpadLibrary.concat(items);
        } else {
            soundpadLibrary = items;
        }

        currentSoundpadOffset += 30;
        renderGrid(soundpadLibrary);
    } catch (_) {
        if (!append) {
            spGrid.innerHTML = `<div class="sp-loading" style="color: var(--accent-red)">${t.spError}</div>`;
        }
    } finally {
        isFetchingSoundpad = false;
    }
}

function renderGrid(items) {
    if (!spGrid) return;
    spGrid.innerHTML = '';
    const t = UI_TEXT;

    const paginationRow = document.getElementById('sp-pagination-row');
    const pageInfo = document.getElementById('sp-page-info');

    if (!items || items.length === 0) {
        spGrid.innerHTML = `<div class="sp-loading">${t.spNotFound}</div>`;
        if (paginationRow) paginationRow.classList.add('hidden');
        return;
    }

    const totalPages = Math.ceil(items.length / SP_PAGE_SIZE);
    if (soundpadPage >= totalPages) soundpadPage = Math.max(0, totalPages - 1);

    const startIdx = soundpadPage * SP_PAGE_SIZE;
    const pageItems = items.slice(startIdx, startIdx + SP_PAGE_SIZE);

    if (paginationRow) {
        paginationRow.classList.remove('hidden');
        if (pageInfo) pageInfo.textContent = `${soundpadPage + 1} / ${totalPages}`;
        if (spBtnPrev) spBtnPrev.disabled = soundpadPage === 0;
        if (spBtnNext) spBtnNext.disabled = soundpadPage === totalPages - 1;

        if (spBtnLoadMore) {
            if (currentSoundpadTab === 'search') {
                spBtnLoadMore.style.display = 'flex';
                spBtnLoadMore.disabled = soundpadPage !== totalPages - 1;
            } else {
                spBtnLoadMore.style.display = 'none';
            }
        }
    }

    pageItems.forEach((item) => {
        const btn = document.createElement('div');
        btn.className = 'sp-btn';
        btn.dataset.soundId = item.id;

        const textEl = document.createElement('div');
        textEl.className = 'sp-btn-text';
        textEl.textContent = item.title || 'Sound';

        const isFav = soundpadFavs.some((f) => f.id === item.id);
        const starEl = document.createElement('div');
        starEl.className = `sp-fav-icon ${isFav ? 'active' : ''}`;
        starEl.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="${isFav ? 'currentColor' : 'none'}" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;

        starEl.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = soundpadFavs.findIndex((f) => f.id === item.id);
            if (idx > -1) {
                soundpadFavs.splice(idx, 1);
                starEl.classList.remove('active');
                starEl.querySelector('svg')?.setAttribute('fill', 'none');
            } else {
                soundpadFavs.push({ id: item.id, title: item.title, extension: item.extension || 'mp3' });
                starEl.classList.add('active');
                starEl.querySelector('svg')?.setAttribute('fill', 'currentColor');
            }
            localStorage.setItem('soundpadFavs', JSON.stringify(soundpadFavs));
            if (currentSoundpadTab === 'fav') renderGrid(soundpadFavs);
        });

        btn.addEventListener('click', () => {
            audioRouter?.resume();
            const rIdx = soundpadRecent.findIndex((r) => r.id === item.id);
            if (rIdx > -1) soundpadRecent.splice(rIdx, 1);
            soundpadRecent.unshift({ id: item.id, title: item.title, extension: item.extension || 'mp3' });
            if (soundpadRecent.length > 30) soundpadRecent.pop();
            localStorage.setItem('soundpadRecent', JSON.stringify(soundpadRecent));

            playSound(btn, item.id, item.extension || 'mp3', item.title);
        });

        btn.appendChild(textEl);
        btn.appendChild(starEl);
        spGrid.appendChild(btn);
    });
}

function playSound(btnElement, id, ext, name) {
    if (currentSoundpadAudio) {
        currentSoundpadAudio.pause();
        currentSoundpadAudio.src = '';
        if (playerRaf) cancelAnimationFrame(playerRaf);
    }

    document.querySelectorAll('.sp-btn').forEach((b) => b.classList.remove('playing'));
    if (btnElement) btnElement.classList.add('playing');

    if (spTitle) spTitle.textContent = name || 'Sound';
    togglePauseIcon(true);

    const safeExt = (ext || 'mp3').replace(/^\./, '');
    const url = `https://cdn.uwupad.me/${id}.${safeExt}`;
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    currentSoundpadAudio = audio;

    audioRouter?.attachSoundpadAudio(audio);

    audio.play().then(() => {
        playerRaf = requestAnimationFrame(updatePlayerUI);
    }).catch(() => {
        if (btnElement) btnElement.classList.remove('playing');
        togglePauseIcon(false);
    });

    audio.onended = () => {
        if (btnElement) btnElement.classList.remove('playing');
        togglePauseIcon(false);
        if (playerRaf) cancelAnimationFrame(playerRaf);
        if (spSeek) spSeek.value = 0;
        if (spTimeCurr) spTimeCurr.textContent = '0:00';
    };
}

function getCurrentTabItems() {
    if (currentSoundpadTab === 'fav') return soundpadFavs;
    if (currentSoundpadTab === 'recent') return soundpadRecent;
    return soundpadLibrary;
}

if (spBtnPrev) {
    spBtnPrev.addEventListener('click', () => {
        if (soundpadPage > 0) {
            soundpadPage--;
            renderGrid(getCurrentTabItems());
        }
    });
}

if (spBtnNext) {
    spBtnNext.addEventListener('click', () => {
        soundpadPage++;
        renderGrid(getCurrentTabItems());
    });
}

if (spBtnLoadMore) {
    spBtnLoadMore.addEventListener('click', () => {
        if (currentSoundpadTab === 'search') {
            loadSoundpad(currentSoundpadQuery, true);
        }
    });
}

if (spSearchInput) {
    let debounceTimer = null;
    spSearchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            currentSoundpadQuery = spSearchInput.value;
            currentSoundpadTab = 'search';
            document.querySelectorAll('.sp-tab').forEach((t) => t.classList.remove('active'));
            document.querySelector('.sp-tab[data-tab="search"]')?.classList.add('active');
            loadSoundpad(currentSoundpadQuery);
        }, 350);
    });
    spSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            clearTimeout(debounceTimer);
            currentSoundpadQuery = spSearchInput.value;
            currentSoundpadTab = 'search';
            document.querySelectorAll('.sp-tab').forEach((t) => t.classList.remove('active'));
            document.querySelector('.sp-tab[data-tab="search"]')?.classList.add('active');
            loadSoundpad(currentSoundpadQuery);
        }
    });
}

document.querySelectorAll('.sp-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.sp-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');

        currentSoundpadTab = tab.getAttribute('data-tab');
        soundpadPage = 0;

        if (currentSoundpadTab === 'search') {
            currentSoundpadQuery = spSearchInput?.value || '';
            loadSoundpad(currentSoundpadQuery);
        } else if (currentSoundpadTab === 'fav') {
            renderGrid(soundpadFavs);
        } else if (currentSoundpadTab === 'recent') {
            renderGrid(soundpadRecent);
        }
    });
});

if (spPeerVolInput) {
    audioRouter?.setSoundpadPeerVolume(spPeerVolInput.value);
    spPeerVolInput.addEventListener('input', (e) => {
        audioRouter?.setSoundpadPeerVolume(e.target.value);
    });
}

if (spMonitorVolInput) {
    audioRouter?.setSoundpadMonitorVolume(spMonitorVolInput.value);
    spMonitorVolInput.addEventListener('input', (e) => {
        audioRouter?.setSoundpadMonitorVolume(e.target.value);
    });
}

toggleSoundpadBtn?.addEventListener('click', () => {
    if (!soundpadPanel) return;
    const isHidden = soundpadPanel.classList.contains('hidden');
    soundpadPanel.classList.toggle('hidden');
    toggleSoundpadBtn.classList.toggle('active', isHidden);

    if (isHidden && !soundpadInitialized) {
        soundpadInitialized = true;
        loadSoundpad();
    }
});

function handleBackgroundMessage(msg) {
    switch (msg.type) {
        case 'TAB_REGISTERED': {
            const tabId = msg.tabId;
            if (!tabCards.has(tabId) && tabCards.size >= TAB_LIMIT) break;
            if (!tabCards.has(tabId)) {
                createTabCard(tabId);
                updateTabStatus(tabId, 'IDLE');
            }
            if (AUDIO_BRIDGE_ENABLED) {
                postToBackground({
                    type: 'AUDIO_TRACK_REQUEST',
                    targetTabId: tabId
                });
            }
            break;
        }

        case 'TAB_CLOSED': {
            audioRouter?.close(msg.tabId);
            removeTabCard(msg.tabId);
            break;
        }

        case 'AUDIO_TRACK_READY': {
            if (!audioRouter) break;
            const inputMuted = tabCards.get(msg.tabId)
                ?.querySelector('.btn-speaker')
                ?.classList.contains('muted') || false;
            audioRouter.open(msg.tabId, { inputMuted }).catch(() => {
                audioRouter.close(msg.tabId);
            });
            break;
        }

        case 'AUDIO_TRACK_SIGNAL': {
            const senderId = msg.senderTabId || msg.tabId;
            if (!audioRouter || !senderId) break;
            audioRouter.handleSignal(senderId, msg.signal).catch(() => {});
            break;
        }

        case 'STRANGER_STATUS': {
            const card = tabCards.get(msg.tabId);
            if (!card) break;
            if (msg.status === 'CONNECTED') {
                updateTabStatus(msg.tabId, 'CONNECTED');
            } else {
                updateTabStatus(msg.tabId, 'SEARCHING');
            }
            break;
        }

        case 'CALL_TIME': {
            updateTabTime(msg.tabId, msg.time);
            break;
        }

        case 'CAPTCHA_REQUIRED': {
            const card = tabCards.get(msg.tabId);
            if (card) {
                card.classList.add('captcha-required');
                chrome.tabs.update(msg.tabId, { active: true }).catch(() => {});
            }
            break;
        }

        case 'CAPTCHA_CLEARED': {
            const card = tabCards.get(msg.tabId);
            if (card) {
                card.classList.remove('captcha-required');
            }
            break;
        }

    }
}

connectToBackground();
