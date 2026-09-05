(function () {
    const makeSafeProxy = (orig, handler) => {
        if (handler.apply) {
            const origApply = handler.apply;
            handler.apply = function (target, thisArg, args) {
                try {
                    return origApply.call(this, target, thisArg, args);
                } catch (e) {
                    if (e && e.stack && typeof e.stack === 'string') {
                        e.stack = e.stack.split('\n')
                            .filter(line => !line.includes('at Object.apply') && !line.includes('fpt.js') && !line.includes('makeSafeProxy'))
                            .join('\n');
                    }
                    throw e;
                }
            };
        }
        return new Proxy(orig, handler);
    };

    const origToString = Function.prototype.toString;
    const hookedFunctions = new WeakMap();
    const proxyToString = makeSafeProxy(origToString, {
        apply(target, thisArg, args) {
            if (hookedFunctions.has(thisArg)) {
                const mapped = hookedFunctions.get(thisArg);
                if (typeof mapped === 'string') return mapped;
                return origToString.call(mapped);
            }
            if (thisArg && thisArg.name === 'toString' && thisArg === Function.prototype.toString) {
                return 'function toString() { [native code] }';
            }
            return target.apply(thisArg, args);
        }
    });
    Function.prototype.toString = proxyToString;
    hookedFunctions.set(Function.prototype.toString, origToString);

    try {
        const origIframeCw = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')?.get;
        if (origIframeCw) {
            const cwGetter = function contentWindow() {
                const cw = origIframeCw.call(this);
                let isHooked = true;
                try { isHooked = cw && cw.__nk_hooked; } catch (e) { return cw; }
                if (cw && !isHooked) {
                    try { cw.Function.prototype.toString = proxyToString; cw.__nk_hooked = true; } catch (e) { }
                }
                return cw;
            };
            hookedFunctions.set(cwGetter, origIframeCw);
            Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
                get: cwGetter, configurable: true, enumerable: true
            });
        }

        const patchIframe = (el) => {
            if (el && el.tagName && el.tagName.toUpperCase() === 'IFRAME') {
                try {
                    const cw = origIframeCw ? origIframeCw.call(el) : el.contentWindow;
                    let isHooked = true;
                    try { isHooked = cw && cw.__nk_hooked; } catch (e) { return; }
                    if (cw && !isHooked) {
                        try { cw.Function.prototype.toString = proxyToString; cw.__nk_hooked = true; } catch (e) { }
                    }
                } catch (e) { }
            }
        };

        ['appendChild', 'insertBefore', 'replaceChild'].forEach(method => {
            if (Node.prototype[method]) {
                const origMethod = Node.prototype[method];
                Node.prototype[method] = makeSafeProxy(origMethod, {
                    apply(target, thisArg, args) {
                        const res = target.apply(thisArg, args);
                        patchIframe(args[0]);
                        return res;
                    }
                });
                hookedFunctions.set(Node.prototype[method], origMethod);
            }
        });

        ['append', 'prepend'].forEach(method => {
            if (Element.prototype[method]) {
                const origMethod = Element.prototype[method];
                Element.prototype[method] = makeSafeProxy(origMethod, {
                    apply(target, thisArg, args) {
                        const res = target.apply(thisArg, args);
                        for (let i = 0; i < args.length; i++) patchIframe(args[i]);
                        return res;
                    }
                });
                hookedFunctions.set(Element.prototype[method], origMethod);
            }
        });
    } catch (e) { }
    try {
        Object.defineProperty(Function.prototype.toString, 'name', { value: 'toString', configurable: true });
    } catch (e) { }

    const SEED = Math.floor(Math.random() * 2147483647);

    const spoofMethod = (target, prop, fakeApply) => {
        try {
            if (!target || !target[prop]) return;
            const origMethod = target[prop];
            const proxyMethod = makeSafeProxy(origMethod, { apply: fakeApply });
            hookedFunctions.set(proxyMethod, origMethod);
            Object.defineProperty(proxyMethod, 'name', { value: origMethod.name || prop, configurable: true });
            Object.defineProperty(proxyMethod, 'length', { value: origMethod.length || 0, configurable: true });
            target[prop] = proxyMethod;
        } catch (_) { }
    };

    const GPU_PROFILES = [
        { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)' }
    ];
    const gpuProfile = GPU_PROFILES[SEED % GPU_PROFILES.length];

    const hookWebGLParam = (proto) => {
        if (!proto) return;
        spoofMethod(proto, 'getParameter', (target, thisArg, args) => {
            const param = args[0];
            if (param === 37445 || param === 0x9245) return gpuProfile.vendor;
            if (param === 37446 || param === 0x9246) return gpuProfile.renderer;
            return target.apply(thisArg, args);
        });
    };
    try {
        hookWebGLParam(window.WebGLRenderingContext?.prototype);
        hookWebGLParam(window.WebGL2RenderingContext?.prototype);
    } catch (_) { }

    try {
        const addNoiseToPixels = (data, seed) => {
            const maxIdx = Math.min(data.length, 100000);
            for (let i = 0; i < maxIdx; i += 4) {
                if ((seed + i) % 7 === 0) data[i] = (data[i] + 1) % 256;
                if ((seed + i) % 11 === 0) data[i + 1] = (data[i + 1] + 1) % 256;
                if ((seed + i) % 13 === 0) data[i + 2] = (data[i + 2] + 1) % 256;
            }
        };

        const hookGetImageData = (proto) => {
            if (!proto || !proto.getImageData) return;
            const orig = proto.getImageData;
            const proxy = makeSafeProxy(orig, {
                apply(target, thisArg, args) {
                    const imgData = target.apply(thisArg, args);
                    if (imgData && imgData.data) addNoiseToPixels(imgData.data, SEED);
                    return imgData;
                }
            });
            hookedFunctions.set(proxy, orig);
            Object.defineProperty(proxy, 'name', { value: 'getImageData', configurable: true });
            Object.defineProperty(proxy, 'length', { value: orig.length, configurable: true });
            proto.getImageData = proxy;
        };

        hookGetImageData(window.CanvasRenderingContext2D?.prototype);
        hookGetImageData(window.OffscreenCanvasRenderingContext2D?.prototype);

        const spoofCanvasExport = (proto, methodName, isOffscreen) => {
            if (!proto || !proto[methodName]) return;
            const orig = proto[methodName];
            const proxy = makeSafeProxy(orig, {
                apply(target, thisArg, args) {
                    try {
                        const width = thisArg.width || 1;
                        const height = thisArg.height || 1;
                        let scratch, ctx;
                        if (isOffscreen && typeof OffscreenCanvas !== 'undefined') {
                            scratch = new OffscreenCanvas(width, height);
                        } else {
                            scratch = document.createElement('canvas');
                            scratch.width = width;
                            scratch.height = height;
                        }
                        ctx = scratch.getContext('2d', { willReadFrequently: true });
                        ctx.drawImage(thisArg, 0, 0);
                        const imgData = ctx.getImageData(0, 0, width, height);
                        addNoiseToPixels(imgData.data, SEED);
                        ctx.putImageData(imgData, 0, 0);
                        return orig.apply(scratch, args);
                    } catch (e) {
                        return target.apply(thisArg, args);
                    }
                }
            });
            hookedFunctions.set(proxy, orig);
            Object.defineProperty(proxy, 'name', { value: methodName, configurable: true });
            Object.defineProperty(proxy, 'length', { value: orig.length, configurable: true });
            proto[methodName] = proxy;
        };

        spoofCanvasExport(window.HTMLCanvasElement?.prototype, 'toDataURL', false);
        spoofCanvasExport(window.HTMLCanvasElement?.prototype, 'toBlob', false);
        spoofCanvasExport(window.OffscreenCanvas?.prototype, 'convertToBlob', true);

        const hookWebGLReadPixels = (proto) => {
            if (!proto || !proto.readPixels) return;
            const orig = proto.readPixels;
            const proxy = makeSafeProxy(orig, {
                apply(target, thisArg, args) {
                    const res = target.apply(thisArg, args);
                    const pixels = args[6];
                    if (pixels && pixels.length) addNoiseToPixels(pixels, SEED);
                    return res;
                }
            });
            hookedFunctions.set(proxy, orig);
            Object.defineProperty(proxy, 'name', { value: 'readPixels', configurable: true });
            Object.defineProperty(proxy, 'length', { value: orig.length, configurable: true });
            proto.readPixels = proxy;
        };

        hookWebGLReadPixels(window.WebGLRenderingContext?.prototype);
        hookWebGLReadPixels(window.WebGL2RenderingContext?.prototype);
    } catch (_) { }

    if (window.AudioBuffer && window.AudioBuffer.prototype) {
        spoofMethod(window.AudioBuffer.prototype, 'getChannelData', (target, thisArg, args) => {
            const data = target.apply(thisArg, args);
            if (data && data.length) {
                const len = Math.min(data.length, 100);
                for (let i = 0; i < len; i += 2) {
                    data[i] = data[i] + (0.0000001 * ((SEED % 5) + 1));
                }
            }
            return data;
        });
    }

    const memoryValues = [2, 4, 8];
    const hardwareValues = [4, 8, 12, 16];
    const spoofGetter = (target, prop, fakeReturn) => {
        try {
            const origDesc = Object.getOwnPropertyDescriptor(target, prop);
            if (!origDesc || !origDesc.get) return;
            const origGet = origDesc.get;
            const proxyGet = makeSafeProxy(origGet, { apply: () => fakeReturn });
            hookedFunctions.set(proxyGet, origGet);
            Object.defineProperty(proxyGet, 'name', { value: 'get ' + prop, configurable: true });
            Object.defineProperty(proxyGet, 'length', { value: 0, configurable: true });
            origDesc.get = proxyGet;
            Object.defineProperty(target, prop, origDesc);
        } catch (_) { }
    };
    spoofGetter(Navigator.prototype, 'deviceMemory', memoryValues[SEED % memoryValues.length]);
    spoofGetter(Navigator.prototype, 'hardwareConcurrency', hardwareValues[SEED % hardwareValues.length]);

    spoofMethod(HTMLElement.prototype, 'click', (target, thisArg, args) => {
        let originalIsTrusted;
        try {
            originalIsTrusted = Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted');
            if (originalIsTrusted && originalIsTrusted.configurable) {
                Object.defineProperty(Event.prototype, 'isTrusted', { get: () => true, configurable: true });
            }
        } catch (e) { }
        const res = target.apply(thisArg, args);
        try {
            if (originalIsTrusted && originalIsTrusted.configurable) {
                Object.defineProperty(Event.prototype, 'isTrusted', originalIsTrusted);
            }
        } catch (e) { }
        return res;
    });

    if (navigator.permissions && navigator.permissions.query) {
        spoofMethod(navigator.permissions.__proto__ || Permissions.prototype, 'query', (target, thisArg, args) => {
            const descriptor = args[0];
            if (descriptor && (descriptor.name === 'microphone' || descriptor.name === 'camera')) {
                return Promise.resolve({ state: 'granted', onchange: null });
            }
            return target.apply(thisArg, args);
        });
    }

    const nativeString = window.String;
    const nativeParse = JSON.parse;
    const nativeStringify = JSON.stringify;
    const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
    const isFingerprintPayload = (value) => value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && hasOwn(value, 'cvha')
        && ['aos', 'sftest', 'kappa6'].some(key => hasOwn(value, key));

    window.String = new Proxy(nativeString, {
        apply(target, thisArg, args) {
            const payload = args[0];
            if (typeof payload !== 'string') {
                return Reflect.apply(target, thisArg, args);
            }

            try {
                const jsonPayload = nativeParse(payload);
                if (isFingerprintPayload(jsonPayload)) {
                    jsonPayload.cvha = window.spoofedCanvas ?? jsonPayload.cvha;
                    jsonPayload.tbc = jsonPayload.tbc > 1 ? 1 : jsonPayload.tbc;
                    jsonPayload.sftest = {
                        "rtcn": true,
                        "rtcHash": "471ddc1351b4e5579a904567599802292049cbcfd7ebca5e78868fa2d5cc8a99",
                        "gumn": false,
                        "gumHash": "c53492e2f7a86614117e6fa5cf9fae0639777ab3271b04d781ae30274aa3dd1e",
                        "acHash": "a7e6e6d09f60ffc56fab8eb2d1f27ecc3632140be9274368821a14269ced28a7",
                        "acm": false,
                        "lsn": true,
                        "lsHash": "27ee7b5f6c3f612568ad26a884e744af5ca7726c562971aa4ae7624a52b0c92d",
                        "fCombinedHash": "b07ea2a9c06bc16c912bbed8ff461cc81fae047c96b9eeecb620de0d0e33004e",
                        "cli": {
                            "ava4": false,
                            "bis7": false,
                            "als": null,
                            "sigma2": {
                                "cli_qa": "471ddc1351b4e5579a904567599802292049cbcfd7ebca5e78868fa2d5cc8a99",
                                "cli_wm": "cb0e907157afcedc3eb51b63b3a99381eedbef07839c8c2678819e98396de0e4",
                                "cli_er": "bab58886de427d138e1cc7af377d8d2fa93a3fae24ed47dc0d044a9266cdc61e",
                                "cli_ty": "9d0e06bf691fc447727aad9a90c6533d785637ff2d973c7b8cb8935155bd689c",
                                "cli_up": "1900c99a05c0e3a65f27857027696be31962de38c72bdafbc046be07793c5f31",
                                "cli_as": "d666202245ec4376158ad55facf7004a9ff5891d703504da89735aabfdab27f8",
                                "cli_df": "6590f3f98d1004d261a8c48a31d787db54c6df83025c0064c442dba31e0031c0",
                                "cli_gh": "8e7681edeedce92bef73dd3007d0acd0442d48c0eb27604b34f0c44e10a2327a",
                                "cli_jk": false,
                                "cli_nm": false,
                                "cli_vb": false,
                                "cli_xc": 0
                            },
                            "tau3": "",
                            "omega8": "scheme"
                        },
                        "lambda5": {
                            "cli_bn": false,
                            "cli_mk": null
                        }
                    };
                    jsonPayload.kappa6 = {
                        "cli_qw": false,
                        "cli_ex": false,
                        "cli_rc": false,
                        "cli_vt": false,
                        "cli_kt": false
                    };
                    jsonPayload.aos = [];
                    jsonPayload.ref = null;
                    jsonPayload.isf = false;
                    return nativeStringify(jsonPayload);
                }
            } catch { }

            return Reflect.apply(target, thisArg, args);
        }
    });

})();
