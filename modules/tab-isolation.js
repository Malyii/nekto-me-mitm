(function () {
    const WN_KEY = '__nkTabId__';
    let TAB_ID;
    try {
        let wn = {};
        if (window.name) {
            try {
                wn = JSON.parse(window.name);
            } catch (_) {
                wn = {};
            }
        }
        if (wn[WN_KEY]) {
            TAB_ID = wn[WN_KEY];
        } else {
            TAB_ID = crypto.randomUUID().slice(0, 8);
            wn[WN_KEY] = TAB_ID;
            window.name = JSON.stringify(wn);
        }
    } catch (_) {
        TAB_ID = Math.random().toString(36).slice(2, 10);
    }

    const PREFIX = `__t${TAB_ID}_`;

    const makeSafeProxy = (orig, handler) => {
        if (handler.apply) {
            const origApply = handler.apply;
            handler.apply = function (target, thisArg, args) {
                try {
                    return origApply.call(this, target, thisArg, args);
                } catch (e) {
                    if (e && e.stack && typeof e.stack === 'string') {
                        e.stack = e.stack.split('\n')
                            .filter(line => !line.includes('at Object.apply') && !line.includes('tab-isolation.js'))
                            .join('\n');
                    }
                    throw e;
                }
            };
        }
        return new Proxy(orig, handler);
    };

    const spoofMethod = (target, prop, fakeApply) => {
        try {
            if (!target || !target[prop]) return;
            const origMethod = target[prop];
            const proxyMethod = makeSafeProxy(origMethod, { apply: fakeApply });
            Object.defineProperty(proxyMethod, 'name', { value: origMethod.name || prop, configurable: true });
            Object.defineProperty(proxyMethod, 'length', { value: origMethod.length || 0, configurable: true });
            target[prop] = proxyMethod;
        } catch (_) {}
    };

    spoofMethod(Storage.prototype, 'setItem', (target, thisArg, args) => {
        if (args.length >= 1 && typeof args[0] === 'string') {
            args[0] = PREFIX + args[0];
        }
        return target.apply(thisArg, args);
    });

    spoofMethod(Storage.prototype, 'getItem', (target, thisArg, args) => {
        if (args.length >= 1 && typeof args[0] === 'string') {
            args[0] = PREFIX + args[0];
        }
        return target.apply(thisArg, args);
    });

    spoofMethod(Storage.prototype, 'removeItem', (target, thisArg, args) => {
        if (args.length >= 1 && typeof args[0] === 'string') {
            args[0] = PREFIX + args[0];
        }
        return target.apply(thisArg, args);
    });

    const _origKey = Storage.prototype.key;
    const _origRemoveItem = Storage.prototype.removeItem;

    spoofMethod(Storage.prototype, 'clear', (target, thisArg, args) => {
        const rm = [];
        for (let i = 0; i < thisArg.length; i++) {
            const k = _origKey.call(thisArg, i);
            if (k && k.startsWith(PREFIX)) rm.push(k);
        }
        rm.forEach(k => _origRemoveItem.call(thisArg, k));
    });

    spoofMethod(Storage.prototype, 'key', (target, thisArg, args) => {
        const idx = args[0] || 0;
        let c = 0;
        for (let i = 0; i < thisArg.length; i++) {
            const k = target.apply(thisArg, [i]);
            if (k && k.startsWith(PREFIX)) {
                if (c === idx) return k.slice(PREFIX.length);
                c++;
            }
        }
        return null;
    });

    if (window.IDBFactory && window.IDBFactory.prototype) {
        spoofMethod(IDBFactory.prototype, 'open', (target, thisArg, args) => {
            if (args.length > 0 && typeof args[0] === 'string') {
                args[0] = PREFIX + args[0];
            }
            return target.apply(thisArg, args);
        });

        spoofMethod(IDBFactory.prototype, 'deleteDatabase', (target, thisArg, args) => {
            if (args.length > 0 && typeof args[0] === 'string') {
                args[0] = PREFIX + args[0];
            }
            return target.apply(thisArg, args);
        });
    }

    if (window.SharedWorker) {
        const _origSW = window.SharedWorker;
        const proxySW = makeSafeProxy(_origSW, {
            construct() {
                throw new Error('SharedWorker is disabled');
            }
        });
        Object.defineProperty(proxySW, 'name', { value: _origSW.name || 'SharedWorker', configurable: true });
        window.SharedWorker = proxySW;
    }

    if (window.BroadcastChannel) {
        const _origBC = window.BroadcastChannel;
        const proxyBC = makeSafeProxy(_origBC, {
            construct(target, args, newTarget) {
                const scopedArgs = [...args];
                scopedArgs[0] = PREFIX + String(scopedArgs[0] ?? '');
                return Reflect.construct(target, scopedArgs, newTarget);
            }
        });
        Object.defineProperty(proxyBC, 'name', { value: _origBC.name || 'BroadcastChannel', configurable: true });
        window.BroadcastChannel = proxyBC;
    }

    window.addEventListener('storage', (e) => {
        e.stopImmediatePropagation();
    }, true);
})();
