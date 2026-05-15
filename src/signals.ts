import { signal } from '@preact/signals-react';
import { NetWork } from './utils/network';
import { storage } from './utils/storage';
import { getKeys } from './utils/keyring';

export const locked = signal(true);
export const network = signal<NetWork>(NetWork.Mainnet);
export const rxdAddress = signal('');
export const identityAddress = signal('');
export const rxdPubKey = signal('');
export const identityPubKey = signal('');
export const isPasswordRequired = signal(true);
export const walletExists = signal(false);

export async function initSignalsFromStorage() {
  await new Promise((resolve, reject) => {
    try {
      storage.get(['isPasswordRequired', 'network'], async (res) => {
        isPasswordRequired.value = res.isPasswordRequired !== 'false';
        network.value = res.network || NetWork.Mainnet;
        resolve(true);
      });
    } catch {
      reject(false);
    }
  });

  // Check if a wallet exists and is unlocked
  await new Promise((resolve) => {
    storage.get(['encryptedKeys'], async (result) => {
      if (result.encryptedKeys) {
        walletExists.value = true;
        const keys = await getKeys();
        if (keys) {
          rxdAddress.value = keys.walletAddress || '';
          identityAddress.value = keys.identityAddress || '';
          rxdPubKey.value = keys.walletPubKey || '';
          identityPubKey.value = keys.identityPubKey || '';
          locked.value = false;
        }
      }
      resolve(true);
    });
  });
}
