# Orbital Wallet — Changes

## Sign Message improvements

- **Default signing key changed to RXD** (`id: 'rxd'`).  
  Previously `signMessage` defaulted to the identity derivation path; it now signs with the wallet (RXD) key, which is the address visible to the user and used for on-chain authentication.

- **No password re-entry when wallet is already unlocked.**  
  `signMessage` in `useRxd.ts` now checks the `locked` signal. When the wallet is unlocked it reads keys from the in-memory keyring (`getKeys()`), bypassing the password prompt entirely.

- **Cancel button added to the Sign Message request page.**  
  A secondary "Cancel" button sits alongside "Sign Message". Clicking it sends a `user-cancelled` error response back to the requesting page before closing the popup, so dApps receive a proper rejection rather than a hanging promise.

- **Sign Message button disables immediately on click.**  
  `flushSync` forces React to synchronously update the DOM before the signing operation begins, preventing duplicate submissions.

- **Popup closes immediately on successful signing.**  
  The previous 2-second delay and "Successfully Signed!" snackbar have been removed. On success the response is dispatched and `window.close()` is called straight away.

- **Sign Message popup shows password field only when wallet is locked.**  
  The password input is now gated on `locked.value` in addition to `isPasswordRequired`, so users who already unlocked the wallet are not asked twice.

## Connect flow fixes

- **Popup opens as the action popup first**, with a fallback to `chrome.windows.create` for older Chrome builds.  
  `launchPopUp` now calls `chrome.action.openPopup()` and falls back gracefully, keeping the UX closer to the toolbar icon.

- **`lastActiveTime` is updated on connect approval** so `isConnected()` checks don't fail immediately after a fresh connection.

- **Whitelist is written with `await`** before the connect response is sent, ensuring `verifyAccess()` sees the new entry before subsequent API calls arrive.

- **Connect popup closes via `window.close()`** instead of `chrome.windows.remove(popupId)`, working correctly for both action popups and standalone windows.

- **Auto-approve already-authorised sites.**  
  The null-check for `thirdPartyAppRequestData` is tightened so already-whitelisted sites are approved without an extra round-trip.

## App / request state sync

- **`chrome.storage.onChanged` listener added in `App.tsx`.**  
  When a new request arrives while the popup is already open, the storage-change listener updates React state immediately, so the correct request page is shown without requiring a popup reload.

## Restore Wallet

- **Legacy wallet toggle added.**  
  A "Legacy wallet (coin type 0)" switch on the restore screen automatically sets derivation paths to `m/44'/0'/0'/0/0` / `m/44'/0'/0'/1/0`, making it easy to recover wallets created with the old coin type without needing expert mode.

- **Derivation path placeholder text corrected.**  
  Expert-mode inputs now show the correct Radiant paths (`m/44'/512'/0'/0/0` and `m/44'/512'/0'/1/0`).

## Background service worker

- **`processSignMessageResponse` handles cancellation.**  
  If the response carries an `error` field the callback is now invoked with `success: false` and the error forwarded, rather than always wrapping with `success: true`. The missing-callback guard no longer throws — it returns early instead.

- **`verifyAccess` simplified** — duplicate `resolve(false)` removed, replaced with a single expression.
