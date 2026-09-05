(function () {
    const NAMESPACE = '__nk_bridge__';
    const NativeRTCPeerConnection = window.RTCPeerConnection;
    const nativeAddIceCandidate = NativeRTCPeerConnection.prototype.addIceCandidate;
    const nativeClose = NativeRTCPeerConnection.prototype.close;
    const nativeReplaceTrack = RTCRtpSender.prototype.replaceTrack;

    let silentSource = null;
    let defaultSilentTrack = null;
    let panelOutputTrack = null;
    let panelOutputTrackEndedHandler = null;
    const pendingOutputStreamResolvers = [];

    function getOrCreateSilentSourceTrack() {
        if (silentSource?.track?.readyState === 'live' && silentSource.context.state !== 'closed') {
            return silentSource.track;
        }

        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
                const context = new AudioCtx();
                const oscillator = context.createOscillator();
                const destination = context.createMediaStreamDestination();
                const gain = context.createGain();
                gain.gain.value = 0;
                oscillator.connect(gain);
                gain.connect(destination);
                oscillator.start();
                const track = destination.stream.getAudioTracks()[0];
                if (track) {
                    track.contentHint = 'speech';
                    track.enabled = true;
                    silentSource = { context, oscillator, gain, destination, track };
                    return track;
                }
            }
        } catch (_) {}
        return null;
    }

    function cloneSilentTrack() {
        const sourceTrack = getOrCreateSilentSourceTrack();
        if (!sourceTrack) return null;

        try {
            const track = sourceTrack.clone();
            track.contentHint = 'speech';
            track.enabled = true;
            return track;
        } catch (_) {
            return null;
        }
    }

    function createSilentStream() {
        const track = cloneSilentTrack();
        return track ? new MediaStream([track]) : new MediaStream();
    }

    function getOrCreateSilentTrack() {
        if (defaultSilentTrack?.readyState === 'live') return defaultSilentTrack;
        defaultSilentTrack = cloneSilentTrack();
        return defaultSilentTrack;
    }

    function createPanelOutputStream() {
        if (!panelOutputTrack || panelOutputTrack.readyState !== 'live') return null;

        try {
            const track = panelOutputTrack.clone();
            track.contentHint = 'speech';
            track.enabled = true;
            return new MediaStream([track]);
        } catch (_) {
            return null;
        }
    }

    const fakeGetUserMedia = async function () {
        const stream = createPanelOutputStream();
        if (stream) return stream;

        trackBridgeRequested = true;
        postAudioTrackReady();
        return new Promise((resolve) => pendingOutputStreamResolvers.push(resolve));
    };

    const legacyGUM = function (c, successCallback, errorCallback) {
        fakeGetUserMedia().then(successCallback).catch(errorCallback || (() => {}));
    };

    const defMethod = (target, prop, fakeFn) => {
        try {
            if (!target) return;
            Object.defineProperty(target, prop, {
                get() { return fakeFn; },
                set() {},
                configurable: true,
                enumerable: true
            });
        } catch (_) {
            try { target[prop] = fakeFn; } catch (_) {}
        }
    };

    if (window.MediaDevices && window.MediaDevices.prototype) {
        defMethod(MediaDevices.prototype, 'getUserMedia', fakeGetUserMedia);
    }
    if (navigator.mediaDevices) {
        defMethod(navigator.mediaDevices, 'getUserMedia', fakeGetUserMedia);
    }
    defMethod(Navigator.prototype, 'getUserMedia', legacyGUM);
    defMethod(Navigator.prototype, 'webkitGetUserMedia', legacyGUM);
    defMethod(Navigator.prototype, 'mozGetUserMedia', legacyGUM);
    defMethod(navigator, 'getUserMedia', legacyGUM);
    defMethod(navigator, 'webkitGetUserMedia', legacyGUM);
    defMethod(navigator, 'mozGetUserMedia', legacyGUM);

    try {
        const AudioCtxProto = window.AudioContext?.prototype || window.webkitAudioContext?.prototype;
        if (AudioCtxProto && AudioCtxProto.createMediaStreamSource) {
            const nativeCreateMediaStreamSource = AudioCtxProto.createMediaStreamSource;
            AudioCtxProto.createMediaStreamSource = function () {
                const silent = createSilentStream();
                return nativeCreateMediaStreamSource.call(this, silent);
            };
        }
    } catch (_) {}

    try {
        const srcObjDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
        if (srcObjDesc && srcObjDesc.set) {
            const origSetSrcObject = srcObjDesc.set;
            Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
                ...srcObjDesc,
                set(stream) {
                    try { this.muted = true; } catch (_) {}
                    if (stream instanceof MediaStream) {
                        const track = stream.getAudioTracks().find((t) => t.readyState === 'live');
                        if (track) usePageAudioTrack(track);
                    }
                    return origSetSrcObject.call(this, stream);
                }
            });
        }
    } catch (_) {}

    let pageAudioTrack = null;
    let pageAudioTrackEndedHandler = null;
    let trackBridgeRequested = false;

    function postAudioTrackReady() {
        if (!trackBridgeRequested) return;
        window.postMessage({
            ns: NAMESPACE,
            dir: 'UP',
            payload: { type: 'AUDIO_TRACK_READY' }
        }, location.origin);
    }

    function postAudioTrackSignal(signal) {
        window.postMessage({
            ns: NAMESPACE,
            dir: 'UP',
            payload: { type: 'AUDIO_TRACK_SIGNAL', signal }
        }, location.origin);
    }

    function usePageAudioTrack(track) {
        if (!track || track.kind !== 'audio' || track.readyState !== 'live') return;
        if (pageAudioTrack === track) {
            if (trackBridgeRequested) postAudioTrackReady();
            return;
        }

        if (pageAudioTrack && pageAudioTrackEndedHandler) {
            pageAudioTrack.removeEventListener('ended', pageAudioTrackEndedHandler);
        }

        pageAudioTrack = track;
        pageAudioTrack.contentHint = 'speech';
        pageAudioTrackEndedHandler = () => {
            if (pageAudioTrack !== track) return;
            pageAudioTrack = null;
            pageAudioTrackEndedHandler = null;
            if (audioTrackBridgeSender) {
                const silentTrack = getOrCreateSilentTrack();
                nativeReplaceTrack.call(audioTrackBridgeSender, silentTrack).catch(() => {});
            }
        };
        pageAudioTrack.addEventListener('ended', pageAudioTrackEndedHandler, { once: true });

        if (audioTrackBridgeSender) {
            nativeReplaceTrack.call(audioTrackBridgeSender, pageAudioTrack).catch(() => {});
        }

        if (trackBridgeRequested) postAudioTrackReady();
    }

    function findPageAudioTrack() {
        const audioElements = [...document.querySelectorAll('audio, video')]
            .sort((left, right) => Number(left.paused) - Number(right.paused));

        for (const el of audioElements) {
            try { el.muted = true; } catch (_) {}
            const track = el.srcObject?.getAudioTracks?.()
                .find((candidate) => candidate.readyState === 'live');
            if (track) return track;
        }
        return null;
    }

    function refreshPageAudioTrack() {
        if (pageAudioTrack?.readyState === 'live') {
            if (trackBridgeRequested) postAudioTrackReady();
            return;
        }
        const track = findPageAudioTrack();
        if (track) usePageAudioTrack(track);
    }

    document.addEventListener('play', (e) => {
        if (e.target && (e.target.tagName === 'AUDIO' || e.target.tagName === 'VIDEO')) {
            try { e.target.muted = true; } catch (_) {}
        }
        refreshPageAudioTrack();
    }, true);
    setInterval(refreshPageAudioTrack, 100);

    let audioTrackBridgePc = null;
    let audioTrackBridgeSender = null;
    let pendingPanelAudioCandidates = [];

    function clearPanelOutputTrack() {
        if (panelOutputTrack && panelOutputTrackEndedHandler) {
            panelOutputTrack.removeEventListener('ended', panelOutputTrackEndedHandler);
        }
        panelOutputTrack = null;
        panelOutputTrackEndedHandler = null;
    }

    function usePanelOutputTrack(track) {
        if (!track || track.kind !== 'audio' || track.readyState !== 'live') return;
        clearPanelOutputTrack();

        panelOutputTrack = track;
        panelOutputTrack.contentHint = 'speech';
        panelOutputTrackEndedHandler = () => {
            if (panelOutputTrack === track) clearPanelOutputTrack();
        };
        panelOutputTrack.addEventListener('ended', panelOutputTrackEndedHandler, { once: true });

        for (const resolve of pendingOutputStreamResolvers.splice(0)) {
            const stream = createPanelOutputStream();
            if (stream) resolve(stream);
        }
    }

    function closeAudioTrackBridge() {
        clearPanelOutputTrack();
        if (audioTrackBridgePc) {
            try { nativeClose.call(audioTrackBridgePc); } catch (_) {}
        }
        audioTrackBridgePc = null;
        audioTrackBridgeSender = null;
        pendingPanelAudioCandidates = [];
    }

    async function addPanelAudioCandidate(candidate) {
        if (!candidate || !audioTrackBridgePc) return;
        if (!audioTrackBridgePc.remoteDescription) {
            pendingPanelAudioCandidates.push(candidate);
            return;
        }
        try {
            await nativeAddIceCandidate.call(
                audioTrackBridgePc,
                new RTCIceCandidate(candidate)
            );
        } catch (_) {}
    }

    async function handleAudioTrackSignal(signal) {
        if (!signal) return;

        if (signal.sdp?.type === 'offer') {
            closeAudioTrackBridge();
            refreshPageAudioTrack();

            const track = pageAudioTrack?.readyState === 'live'
                ? pageAudioTrack
                : getOrCreateSilentTrack();

            const pc = new NativeRTCPeerConnection({ iceServers: [] });
            audioTrackBridgePc = pc;

            pc.ontrack = (event) => {
                if (event.track.kind !== 'audio' || audioTrackBridgePc !== pc) return;
                usePanelOutputTrack(event.track);
            };

            pc.onicecandidate = (event) => {
                if (event.candidate && audioTrackBridgePc === pc) {
                    postAudioTrackSignal({ candidate: event.candidate.toJSON() });
                }
            };

            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

            const transceiver = pc.getTransceivers().find(
                (t) => t.receiver?.track?.kind === 'audio'
            );
            if (!transceiver || audioTrackBridgePc !== pc) return;

            transceiver.direction = 'sendrecv';
            audioTrackBridgeSender = transceiver.sender;
            await nativeReplaceTrack.call(audioTrackBridgeSender, track);

            for (const candidate of pendingPanelAudioCandidates.splice(0)) {
                await nativeAddIceCandidate.call(pc, new RTCIceCandidate(candidate));
            }

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            if (audioTrackBridgePc !== pc) return;

            postAudioTrackSignal({
                sdp: {
                    type: pc.localDescription.type,
                    sdp: pc.localDescription.sdp
                }
            });
            return;
        }

        if (signal.candidate) {
            await addPanelAudioCandidate(signal.candidate);
        }
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (!event.data || event.data.ns !== NAMESPACE || event.data.dir !== 'DOWN') return;
        const message = event.data.payload;

        if (message.type === 'AUDIO_TRACK_REQUEST') {
            trackBridgeRequested = true;
            refreshPageAudioTrack();
            postAudioTrackReady();
        } else if (message.type === 'AUDIO_TRACK_SIGNAL') {
            void handleAudioTrackSignal(message.signal).catch(() => {});
        }
    }, true);

    window.addEventListener('pagehide', closeAudioTrackBridge, { once: true });
})();
