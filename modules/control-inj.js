(function () {
    const NAMESPACE = '__nk_bridge__';
    const START_SELECTORS = [
        '#searchCompanyBtn',
        '.callScreen__findBtn',
        'button.go-scan-button',
        '.go-scan-button',
        '[class*="findBtn"]',
        'button.start-talk-button',
        '.start-talk-button',
        '.button-start',
        'button.talk-again-button',
        '.talk-again-button',
        '[class*="startBtn"]',
        'button[class*="scan"]'
    ];
    const NEXT_SELECTORS = [
        '.next-btn',
        '.callScreen__nextBtn',
        'button.next-button',
        '[class*="nextBtn"]'
    ];
    const STOP_SELECTORS = [
        '.callScreen__cancelCallBtn',
        '.cancelCallBtnNoMess',
        'button.stop-talk-button',
        '.btn-stop-search',
        'button.stop-scan-button',
        '.stop-scan-button',
        '[class*="cancelCall"]',
        '.button-stop',
        '[class*="stopBtn"]'
    ];
    const CONFIRM_SELECTORS = [
        '.swal2-popup.swal2-show .swal2-confirm',
        '.swal2-confirm.swal2-styled',
        '.swal2-confirm',
        '.swal2-popup button.swal2-confirm',
        '.swal2-actions button.swal2-confirm',
        '.modal-confirm',
        'button[class*="confirm"]'
    ];

    let isUserRequestedStop = false;
    let fastNextToken = 0;
    let fastNextObserver = null;
    let reconnectTimeout = null;

    let lastStatus = null;
    let lastStatusSentAt = 0;
    let lastCallTime = null;
    let captchaVisible = false;
    let captchaRound = 0;

    function post(payload) {
        window.postMessage({ ns: NAMESPACE, dir: 'UP', payload }, location.origin);
    }

    function safeClick(element) {
        if (!element?.isConnected || !isClickable(element)) return false;
        try {
            element.click();
            return true;
        } catch (_) {
            return false;
        }
    }

    function isClickable(element) {
        if (!element || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function findClickable(selectors) {
        for (const selector of selectors) {
            for (const element of document.querySelectorAll(selector)) {
                if (isClickable(element)) return element;
            }
        }
        return null;
    }

    function findStartButton() {
        return findClickable(START_SELECTORS);
    }

    function findNextButton() {
        const iconButton = document.querySelector('.icon-next-button')?.parentElement;
        if (isClickable(iconButton)) return iconButton;
        return findClickable(NEXT_SELECTORS);
    }

    function findStopButton() {
        const iconButton = document.querySelector('.icon-stop-button')?.parentElement;
        if (isClickable(iconButton)) return iconButton;
        return findClickable(STOP_SELECTORS);
    }

    function findConfirmButton() {
        return findClickable(CONFIRM_SELECTORS);
    }

    function isInActiveCall() {
        const timeElement = document.querySelector('.callScreen__time');
        const hasTime = Boolean(timeElement && timeElement.innerText && timeElement.innerText !== '00:00');
        const hasCancel = Boolean(document.querySelector('.callScreen__cancelCallBtn, .cancelCallBtnNoMess, [class*="cancelCall"]'));
        return hasTime || hasCancel;
    }

    function cancelFastNextSearch() {
        fastNextToken += 1;
        if (fastNextObserver) {
            fastNextObserver.disconnect();
            fastNextObserver = null;
        }
    }

    function startNextImmediately() {
        cancelFastNextSearch();
        const token = fastNextToken;
        const startedAt = performance.now();
        let stopClicked = false;
        let retryTimer = null;
        let observer = null;
        const clickedElements = new WeakSet();

        const clickOnce = (element) => {
            if (!element || clickedElements.has(element)) return false;
            clickedElements.add(element);
            return safeClick(element);
        };

        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }

        const finish = () => {
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = null;
            if (observer) observer.disconnect();
            if (fastNextObserver === observer) {
                fastNextObserver = null;
            }
        };

        const retry = () => {
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = setTimeout(attempt, 25);
        };

        const attempt = () => {
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = null;
            if (token !== fastNextToken || isUserRequestedStop) {
                finish();
                return;
            }

            const confirmBtn = findConfirmButton();
            if (confirmBtn) {
                clickOnce(confirmBtn);
                retry();
                return;
            }

            if (isInActiveCall() || (!stopClicked && findStopButton())) {
                const stopBtn = findStopButton();
                if (stopBtn) {
                    stopClicked = true;
                    clickOnce(stopBtn);
                    retry();
                    return;
                }
            }

            const startBtn = findStartButton();
            if (startBtn && !isInActiveCall()) {
                clickOnce(startBtn);
                finish();
                return;
            }

            const nextBtn = findNextButton();
            if (nextBtn) {
                clickOnce(nextBtn);
                retry();
                return;
            }

            if (performance.now() - startedAt < 3500) {
                retry();
            } else {
                finish();
            }
        };

        observer = new MutationObserver(attempt);
        fastNextObserver = observer;
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'disabled', 'aria-disabled']
        });
        attempt();
    }

    function stop() {
        cancelFastNextSearch();
        isUserRequestedStop = true;
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }

        const stopBtn = findStopButton();
        if (stopBtn) {
            safeClick(stopBtn);
            let count = 0;
            const timer = setInterval(() => {
                count += 1;
                const confirmBtn = findConfirmButton();
                if (confirmBtn) {
                    clearInterval(timer);
                    safeClick(confirmBtn);
                } else if (count > 30) {
                    clearInterval(timer);
                }
            }, 45);
        }
    }

    function triggerAutoReconnect() {
        if (isUserRequestedStop) return;
        if (fastNextObserver) return;
        if (reconnectTimeout) return;
        reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null;
            startNextImmediately();
        }, 25);
    }

    function hasVisibleCaptcha() {
        const selector = [
            'iframe[src*="captcha" i]',
            'iframe[src*="recaptcha" i]',
            'iframe[title*="recaptcha" i]',
            'iframe[src*="hcaptcha" i]',
            'iframe[src*="turnstile" i]',
            'iframe[src*="smartcaptcha" i]',
            '.smart-captcha',
            '.g-recaptcha',
            '.h-captcha',
            '.cf-turnstile',
            '[data-sitekey]'
        ].join(',');
        return [...document.querySelectorAll(selector)].some((element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 4 && rect.height > 4;
        });
    }

    function updatePageState() {
        const timeElement = document.querySelector('.callScreen__time');
        const status = timeElement ? 'CONNECTED' : 'DISCONNECTED';
        const disconnectedAfterCall = lastStatus === 'CONNECTED' && status === 'DISCONNECTED';

        if (status !== lastStatus || Date.now() - lastStatusSentAt >= 1000) {
            lastStatus = status;
            lastStatusSentAt = Date.now();
            post({ type: 'STRANGER_STATUS', status });
        }

        if (disconnectedAfterCall && !isUserRequestedStop) {
            triggerAutoReconnect();
        }

        const callTime = timeElement?.innerText || '00:00';
        if (callTime !== lastCallTime) {
            lastCallTime = callTime;
            post({ type: 'CALL_TIME', time: callTime });
        }

        const captchaNow = hasVisibleCaptcha();
        if (captchaNow !== captchaVisible) {
            captchaVisible = captchaNow;
            if (captchaNow) captchaRound += 1;
            post({ type: captchaNow ? 'CAPTCHA_REQUIRED' : 'CAPTCHA_CLEARED', round: captchaRound });
        }
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (!event.data || event.data.ns !== NAMESPACE || event.data.dir !== 'DOWN') return;
        const message = event.data.payload;
        if (message.type !== 'ACTION') return;

        if (message.action === 'NEXT') {
            isUserRequestedStop = false;
            startNextImmediately();
        } else if (message.action === 'STOP') {
            stop();
        }
    }, true);

    window.setInterval(updatePageState, 200);
    updatePageState();
})();
