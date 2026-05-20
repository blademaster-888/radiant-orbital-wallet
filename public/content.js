/* global chrome */

const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
(document.head || document.documentElement).appendChild(script);

document.addEventListener('OrbitalRequest', (e) => {
  if (!e?.detail?.type) return;
  const { type, params: originalParams = {} } = e.detail;

  let params = {};

  if (type === 'connect') {
    params.appName = document.title || document.querySelector('meta[name="application-name"]')?.content || 'Unknown';
    params.appIcon =
      document.querySelector('link[rel="apple-touch-icon"]')?.href ||
      document.querySelector('link[rel="icon"]')?.href ||
      '';
  }

  if (Array.isArray(originalParams)) {
    params.data = originalParams;
  } else if (typeof originalParams === 'object') {
    params = { ...params, ...originalParams };
  }

  params.domain = window.location.hostname;

  const messageId = e.detail.messageId;
  chrome.runtime.sendMessage({ action: type, params }, (response) => {
    if (chrome.runtime.lastError) {
      // Extension was reloaded — page must be refreshed for content script to reconnect
      const errorEvent = new CustomEvent(messageId, {
        detail: { type, success: false, error: 'Wallet disconnected — please refresh the page and try again.' },
      });
      document.dispatchEvent(errorEvent);
      return;
    }
    if (response != null) {
      document.dispatchEvent(new CustomEvent(messageId, { detail: response }));
    }
  });
});

chrome.runtime.onMessage.addListener((message) => {
  const { type, action, params } = message;
  if (type === 'OrbitalEmitEvent') {
    const event = new CustomEvent(type, { detail: { action, params } });
    document.dispatchEvent(event);
  }
});
