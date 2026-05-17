const createOrbitalMethod = (type) => {
  return async (params) => {
    return new Promise((resolve, reject) => {
      // Send request
      const messageId = `${type}-${Date.now()}-${Math.random()}`;
      const requestEvent = new CustomEvent('OrbitalRequest', {
        detail: { messageId, type, params },
      });
      document.dispatchEvent(requestEvent);

      // Listen for a response
      function onResponse(e) {
        if (e.detail.type === type) {
          if (e.detail.success) {
            resolve(e.detail.data);
          } else {
            reject(e.detail.error);
          }
        }
      }

      document.addEventListener(messageId, onResponse, { once: true });
    });
  };
};

const createOrbitalEventEmitter = () => {
  const eventListeners = new Map(); // Object to store event listeners
  const whitelistedEvents = ['signedOut', 'networkChanged']; // Whitelisted event names

  const on = (eventName, callback) => {
    // Check if the provided event name is in the whitelist
    if (whitelistedEvents.includes(eventName)) {
      if (!eventListeners.has(eventName)) {
        eventListeners.set(eventName, []);
      }
      eventListeners.get(eventName).push(callback);
    } else {
      console.error('Event name is not whitelisted:', eventName);
    }
  };

  const removeListener = (eventName, callback) => {
    const listeners = eventListeners.get(eventName);
    if (listeners) {
      eventListeners.set(
        eventName,
        listeners.filter((fn) => fn !== callback),
      );
    }
  };

  return Object.freeze({
    get eventListeners() {
      return eventListeners;
    },
    get whitelistedEvents() {
      return whitelistedEvents;
    },
    on,
    removeListener,
  });
};

const provider = {
  isReady: true,
  ...createOrbitalEventEmitter(),
  connect: createOrbitalMethod('connect'),
  disconnect: createOrbitalMethod('disconnect'),
  isConnected: createOrbitalMethod('isConnected'),
  getPubKeys: createOrbitalMethod('getPubKeys'),
  getAddresses: createOrbitalMethod('getAddresses'),
  getNetwork: createOrbitalMethod('getNetwork'),
  getBalance: createOrbitalMethod('getBalance'),
  getTokens: createOrbitalMethod('getTokens'),
  sendRxd: createOrbitalMethod('sendRxd'),
  transferToken: createOrbitalMethod('transferToken'),
  transferGlyphFt: createOrbitalMethod('transferToken'),
  signMessage: createOrbitalMethod('signMessage'),
  broadcast: createOrbitalMethod('broadcast'),
  getSignatures: createOrbitalMethod('getSignatures'),
  getSocialProfile: createOrbitalMethod('getSocialProfile'),
  getPaymentUtxos: createOrbitalMethod('getPaymentUtxos'),
  getExchangeRate: createOrbitalMethod('getExchangeRate'),
  encrypt: createOrbitalMethod('encrypt'),
  decrypt: createOrbitalMethod('decrypt'),
  createSwapOffer: createOrbitalMethod('createSwapOffer'),
  completeSwapOffer: createOrbitalMethod('completeSwapOffer'),
};

window.orbital = provider;

document.addEventListener('OrbitalEmitEvent', (event) => {
  const { action, params } = event.detail;
  // Check if window.orbital is defined and has event listeners for the action
  if (window.orbital && window.orbital.eventListeners && window.orbital.eventListeners.has(action)) {
    const listeners = window.orbital.eventListeners.get(action);
    // Trigger each listener with the provided params
    listeners.forEach((callback) => callback(params));
  }
});

document.addEventListener('OrbitalEmitEvent', (event) => {
  const { action, params } = event.detail;
  // Check if window.orbital is defined and has event listeners for the action
  if (window.orbital && window.orbital.eventListeners && window.orbital.eventListeners.has(action)) {
    const listeners = window.orbital.eventListeners.get(action);
    // Trigger each listener with the provided params
    listeners.forEach((callback) => callback(params));
  }
});
