export class PairedAudioRouter {
    constructor({ sendSignal, onMonitorState = () => {}, onVoiceActivity = () => {} }) {
        this.sendSignal = sendSignal;
        this.onMonitorState = onMonitorState;
        this.onVoiceActivity = onVoiceActivity;
        this.peers = new Map();
        this.tabOrder = [];
        this.audioCtx = null;

        this.soundpadPeerGain = null;
        this.soundpadMonitorGain = null;
        this.soundpadPeerVolume = 0.85;
        this.soundpadMonitorVolume = 0.85;
        this.soundpadSourceNodes = new WeakMap();

        this.microphoneTrack = null;
        this.microphoneSource = null;
        this.microphoneGain = null;
        this.microphoneEndedHandler = null;
    }

    getAudioContext() {
        if (!this.audioCtx || this.audioCtx.state === 'closed') {
            const Context = window.AudioContext || window.webkitAudioContext;
            if (Context) this.audioCtx = new Context();
        }
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            void this.audioCtx.resume().catch(() => {});
        }
        this.ensureSoundpadGains();
        return this.audioCtx;
    }

    ensureSoundpadGains() {
        if (!this.audioCtx || this.audioCtx.state === 'closed') return;

        if (!this.soundpadPeerGain) {
            this.soundpadPeerGain = this.audioCtx.createGain();
            this.soundpadPeerGain.gain.value = this.soundpadPeerVolume;
            for (const peer of this.peers.values()) {
                if (peer.mixDest) {
                    try { this.soundpadPeerGain.connect(peer.mixDest); } catch (_) {}
                }
            }
        }

        if (!this.soundpadMonitorGain) {
            this.soundpadMonitorGain = this.audioCtx.createGain();
            this.soundpadMonitorGain.gain.value = this.soundpadMonitorVolume;
            try {
                this.soundpadMonitorGain.connect(this.audioCtx.destination);
            } catch (_) {}
        }
    }

    setSoundpadPeerVolume(volume) {
        this.soundpadPeerVolume = Math.max(0, Math.min(2.0, parseFloat(volume) || 0));
        if (this.soundpadPeerGain) {
            this.soundpadPeerGain.gain.value = this.soundpadPeerVolume;
        }
    }

    setSoundpadMonitorVolume(volume) {
        this.soundpadMonitorVolume = Math.max(0, Math.min(2.0, parseFloat(volume) || 0));
        if (this.soundpadMonitorGain) {
            this.soundpadMonitorGain.gain.value = this.soundpadMonitorVolume;
        }
    }

    attachSoundpadAudio(audioElement) {
        const ctx = this.getAudioContext();
        if (!ctx || !audioElement) return;

        try {
            let sourceNode = this.soundpadSourceNodes.get(audioElement);
            if (!sourceNode) {
                sourceNode = ctx.createMediaElementSource(audioElement);
                this.soundpadSourceNodes.set(audioElement, sourceNode);
            }

            this.ensureSoundpadGains();
            if (this.soundpadPeerGain && this.soundpadMonitorGain) {
                sourceNode.connect(this.soundpadPeerGain);
                sourceNode.connect(this.soundpadMonitorGain);
            } else {
                sourceNode.connect(ctx.destination);
            }
        } catch (_) {}
    }

    setMicrophoneTrack(track) {
        this.clearMicrophoneTrack();
        if (!track) return;
        if (track.kind !== 'audio' || track.readyState !== 'live') {
            throw new Error('A live audio track is required');
        }

        const ctx = this.getAudioContext();
        if (!ctx) throw new Error('Web Audio is unavailable');

        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        const gain = ctx.createGain();
        gain.gain.value = 1;
        source.connect(gain);

        for (const peer of this.peers.values()) {
            if (!peer.mixDest) continue;
            try { gain.connect(peer.mixDest); } catch (_) {}
        }

        this.microphoneTrack = track;
        this.microphoneSource = source;
        this.microphoneGain = gain;
        this.microphoneEndedHandler = () => {
            if (this.microphoneTrack === track) this.clearMicrophoneTrack(false);
        };
        track.addEventListener('ended', this.microphoneEndedHandler, { once: true });
    }

    clearMicrophoneTrack(stopTrack = true) {
        const track = this.microphoneTrack;
        if (track && this.microphoneEndedHandler) {
            track.removeEventListener('ended', this.microphoneEndedHandler);
        }
        try { this.microphoneSource?.disconnect(); } catch (_) {}
        try { this.microphoneGain?.disconnect(); } catch (_) {}

        this.microphoneTrack = null;
        this.microphoneSource = null;
        this.microphoneGain = null;
        this.microphoneEndedHandler = null;

        if (stopTrack && track?.readyState === 'live') track.stop();
    }

    startVad(peer, track) {
        this.stopVad(peer);
        const ctx = this.getAudioContext();
        if (!ctx) return;

        try {
            const stream = new MediaStream([track]);
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.3;
            source.connect(analyser);

            peer.vadSource = source;

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            let isSpeaking = false;
            let silenceCount = 0;

            const check = () => {
                if (peer.inputTrack !== track) return;
                analyser.getByteFrequencyData(dataArray);

                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sum += dataArray[i];
                }
                const avg = sum / dataArray.length;

                if (avg > 10) {
                    silenceCount = 0;
                    if (!isSpeaking) {
                        isSpeaking = true;
                        this.onVoiceActivity(peer.tabId, true);
                    }
                } else {
                    silenceCount++;
                    if (silenceCount > 6 && isSpeaking) {
                        isSpeaking = false;
                        this.onVoiceActivity(peer.tabId, false);
                    }
                }

                peer.vadRaf = requestAnimationFrame(check);
            };

            peer.vadRaf = requestAnimationFrame(check);
        } catch (_) {}
    }

    stopVad(peer) {
        if (peer.vadRaf) {
            cancelAnimationFrame(peer.vadRaf);
            peer.vadRaf = null;
        }
        try {
            peer.vadSource?.disconnect();
        } catch (_) {}
        peer.vadSource = null;
        this.onVoiceActivity(peer.tabId, false);
    }

    async open(tabId, { inputMuted = false } = {}) {
        const existingPeer = this.peers.get(tabId);
        if (existingPeer && !['closed', 'failed', 'disconnected'].includes(existingPeer.pc.connectionState)) {
            this.setInputMuted(tabId, inputMuted);
            return;
        }
        if (existingPeer) this.close(tabId);
        if (this.peers.size >= 2) return;

        const ctx = this.getAudioContext();
        const mixDest = ctx ? ctx.createMediaStreamDestination() : null;
        const mixTrack = mixDest ? mixDest.stream.getAudioTracks()[0] : null;

        if (this.soundpadPeerGain && mixDest) {
            try { this.soundpadPeerGain.connect(mixDest); } catch (_) {}
        }
        if (this.microphoneGain && mixDest) {
            try { this.microphoneGain.connect(mixDest); } catch (_) {}
        }

        const pc = new RTCPeerConnection({ iceServers: [] });
        const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
        const peer = {
            tabId,
            pc,
            transceiver,
            mixDest,
            mixTrack,
            inputSourceNode: null,
            inputTrack: null,
            inputEndedHandler: null,
            monitorAudio: null,
            monitorAvailable: false,
            inputMuted: Boolean(inputMuted),
            vadSource: null,
            vadRaf: null,
            desiredOutputTrack: null,
            appliedOutputTrack: null,
            outputRoutePromise: Promise.resolve(),
            pendingRemoteCandidates: [],
            pendingLocalCandidates: [],
            offerSent: false
        };
        this.peers.set(tabId, peer);

        pc.addEventListener('icecandidate', ({ candidate }) => {
            if (!candidate || this.peers.get(tabId) !== peer) return;
            const payload = candidate.toJSON();
            if (!peer.offerSent) {
                peer.pendingLocalCandidates.push(payload);
                return;
            }
            this.sendSignal(tabId, { candidate: payload });
        });

        pc.addEventListener('track', (event) => {
            if (event.track.kind === 'audio' && this.peers.get(tabId) === peer) {
                this.attachInputTrack(peer, event.track);
            }
        });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.sendSignal(tabId, {
            sdp: {
                type: pc.localDescription.type,
                sdp: pc.localDescription.sdp
            }
        });

        peer.offerSent = true;
        for (const candidate of peer.pendingLocalCandidates.splice(0)) {
            this.sendSignal(tabId, { candidate });
        }

        this.routePair();
    }

    close(tabId) {
        const peer = this.peers.get(tabId);
        if (!peer) return;
        this.stopVad(peer);
        this.disconnectInputTrack(peer);

        if (this.soundpadPeerGain && peer.mixDest) {
            try { this.soundpadPeerGain.disconnect(peer.mixDest); } catch (_) {}
        }
        if (this.microphoneGain && peer.mixDest) {
            try { this.microphoneGain.disconnect(peer.mixDest); } catch (_) {}
        }

        try {
            peer.pc.close();
        } catch {}
        this.peers.delete(tabId);
        this.routePair();
    }

    async handleSignal(tabId, signal) {
        const peer = this.peers.get(tabId);
        if (!peer || !signal) return;

        if (signal.sdp?.type === 'answer') {
            await peer.pc.setRemoteDescription(signal.sdp);
            for (const candidate of peer.pendingRemoteCandidates.splice(0)) {
                await peer.pc.addIceCandidate(candidate);
            }
            return;
        }

        if (!signal.candidate) return;
        if (peer.pc.remoteDescription) {
            await peer.pc.addIceCandidate(signal.candidate);
        } else {
            peer.pendingRemoteCandidates.push(signal.candidate);
        }
    }

    setInputMuted(tabId, muted) {
        const peer = this.peers.get(tabId);
        if (!peer) return;

        peer.inputMuted = Boolean(muted);
        if (peer.inputTrack) {
            try { peer.inputTrack.enabled = !peer.inputMuted; } catch (_) {}
        }
        if (peer.monitorAudio) {
            peer.monitorAudio.muted = peer.inputMuted;
            if (!peer.inputMuted && peer.monitorAudio.paused) {
                void peer.monitorAudio.play().catch(() => {});
            }
        }
        if (peer.inputMuted) this.onVoiceActivity(tabId, false);
        this.routePair();
    }

    setTabOrder(tabIds) {
        this.tabOrder = tabIds.slice(0, 2);
        this.routePair();
    }

    resume() {
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            void this.audioCtx.resume().catch(() => {});
        }
        for (const peer of this.peers.values()) {
            if (peer.monitorAudio && peer.monitorAudio.paused && !peer.inputMuted) {
                void peer.monitorAudio.play().catch(() => {});
            }
        }
    }

    dispose() {
        this.clearMicrophoneTrack();
        for (const tabId of [...this.peers.keys()]) this.close(tabId);
        if (this.audioCtx && this.audioCtx.state !== 'closed') {
            void this.audioCtx.close().catch(() => {});
            this.audioCtx = null;
        }
    }

    attachInputTrack(peer, track) {
        if (peer.inputTrack === track) return;
        this.disconnectInputTrack(peer);
        peer.inputTrack = track;
        peer.inputEndedHandler = () => {
            if (peer.inputTrack !== track) return;
            this.disconnectInputTrack(peer);
            this.routePair();
        };
        track.addEventListener('ended', peer.inputEndedHandler, { once: true });
        try { track.enabled = !peer.inputMuted; } catch (_) {}
        this.startMonitor(peer, track);
        this.startVad(peer, track);
        this.routePair();
    }

    startMonitor(peer, track) {
        let monitorAudio = peer.monitorAudio;
        if (!monitorAudio) {
            monitorAudio = document.createElement('audio');
            monitorAudio.autoplay = true;
            monitorAudio.playsInline = true;
            monitorAudio.id = `monitor-audio-${peer.tabId}`;
            monitorAudio.style.display = 'none';
            document.body.appendChild(monitorAudio);
            peer.monitorAudio = monitorAudio;
        }

        monitorAudio.srcObject = new MediaStream([track]);
        monitorAudio.muted = Boolean(peer.inputMuted);
        monitorAudio.volume = 1.0;
        void monitorAudio.play().catch(() => {});

        this.setMonitorAvailable(peer, true);
    }

    stopMonitor(peer) {
        if (peer.monitorAudio) {
            try {
                peer.monitorAudio.pause();
                peer.monitorAudio.srcObject = null;
                peer.monitorAudio.remove();
            } catch (_) {}
            peer.monitorAudio = null;
        }
        this.setMonitorAvailable(peer, false);
    }

    setMonitorAvailable(peer, available) {
        const next = Boolean(available);
        if (peer.monitorAvailable === next) return;
        peer.monitorAvailable = next;
        this.onMonitorState(peer.tabId, next);
    }

    disconnectInputTrack(peer) {
        this.stopVad(peer);
        if (peer.inputSourceNode) {
            try { peer.inputSourceNode.disconnect(); } catch (_) {}
            peer.inputSourceNode = null;
        }
        if (peer.inputTrack && peer.inputEndedHandler) {
            peer.inputTrack.removeEventListener('ended', peer.inputEndedHandler);
        }
        this.stopMonitor(peer);
        peer.inputTrack = null;
        peer.inputEndedHandler = null;
    }

    routePair() {
        const ctx = this.getAudioContext();
        const [left, right] = this.tabOrder.map((tabId) => this.peers.get(tabId));

        for (const peer of this.peers.values()) {
            if (peer.inputSourceNode) {
                try { peer.inputSourceNode.disconnect(); } catch (_) {}
                peer.inputSourceNode = null;
            }
        }

        if (ctx && left && right) {
            if (!left.inputMuted && left.inputTrack?.readyState === 'live' && right.mixDest) {
                try {
                    left.inputSourceNode = ctx.createMediaStreamSource(new MediaStream([left.inputTrack]));
                    left.inputSourceNode.connect(right.mixDest);
                } catch (_) {}
            }
            if (!right.inputMuted && right.inputTrack?.readyState === 'live' && left.mixDest) {
                try {
                    right.inputSourceNode = ctx.createMediaStreamSource(new MediaStream([right.inputTrack]));
                    right.inputSourceNode.connect(left.mixDest);
                } catch (_) {}
            }
        }

        for (const peer of this.peers.values()) {
            const outTrack = peer.mixTrack?.readyState === 'live' ? peer.mixTrack : null;
            this.setOutputTrack(peer, outTrack);
        }
    }

    setOutputTrack(peer, track) {
        peer.desiredOutputTrack = track?.readyState === 'live' ? track : null;
        peer.outputRoutePromise = peer.outputRoutePromise
            .catch(() => {})
            .then(async () => {
                while (peer.appliedOutputTrack !== peer.desiredOutputTrack) {
                    const desiredTrack = peer.desiredOutputTrack;
                    await peer.transceiver.sender.replaceTrack(desiredTrack);
                    peer.appliedOutputTrack = desiredTrack;
                }
            })
            .catch(() => {});
    }
}
