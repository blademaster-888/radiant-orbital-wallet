import { identityAddress, identityPubKey, locked, rxdAddress, rxdPubKey } from '../signals';
import { retrieveKeys } from './crypto';
import { Keys } from './keys';
import { session, storage } from './storage';

export async function unlock(password: string, timeoutMinutes = 30): Promise<boolean> {
  const timeout = new Date().getTime() + timeoutMinutes * 60000;
  try {
    const keys = await retrieveKeys(password);
    session.set({ keys, timeout });

    rxdAddress.value = keys.walletAddress || '';
    identityAddress.value = keys.identityAddress || '';
    rxdPubKey.value = keys.walletPubKey || '';
    identityPubKey.value = keys.identityPubKey || '';

    return true;
  } catch (error) {
    return false;
  }
}

export function lock() {
  session.clear();

  rxdAddress.value = '';
  identityAddress.value = '';
  rxdPubKey.value = '';
  identityPubKey.value = '';
  locked.value = true;
  const timestamp = Date.now();
  const twentyMinutesAgo = timestamp - 20 * 60 * 1000;
  storage.set({ lastActiveTime: twentyMinutesAgo });
  storage.remove('appState');
}

export function getKeys(): Promise<Keys | undefined> {
  return new Promise((resolve) => {
    session.get(['keys', 'timeout'], ({ keys, timeout }) => {
      const time = Date.now();
      if (timeout <= time) {
        lock();
        resolve(undefined);
      } else if (keys) {
        resolve(keys);
      } else {
        resolve(undefined);
      }
    });
  });
}
