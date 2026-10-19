// dx.block: answer "Allow notifications?" prompts with "no" before they appear
try {
    if (window.Notification) {
        Object.defineProperty(Notification, 'permission', { get: () => 'denied', configurable: true });
        Notification.requestPermission = function requestPermission(cb) {
            if (typeof cb === 'function') setTimeout(() => cb('denied'));
            return Promise.resolve('denied');
        };
    }
    if (window.PushManager) {
        PushManager.prototype.subscribe = function subscribe() { return Promise.reject(new DOMException('Registration failed - permission denied', 'NotAllowedError')); };
        PushManager.prototype.permissionState = function permissionState() { return Promise.resolve('denied'); };
    }
} catch { /* ignore */ }
