// dx.block: advertise the Global Privacy Control opt-out signal to page scripts (https://globalprivacycontrol.org)
try {
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true });
    Object.defineProperty(Navigator.prototype, 'doNotTrack', { get: () => '1', configurable: true });
} catch { /* ignore */ }
