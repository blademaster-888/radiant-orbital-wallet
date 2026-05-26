import { ECIESCiphertext, P2PKHAddress, PrivateKey, PublicKey } from 'rxd-wasm';
import { hexToBytes, concatBytes, bytesToHex, randomBytes } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { scrypt } from '@noble/hashes/scrypt';
import { isPasswordRequired } from '../signals';
import { storage } from './storage';
import { Keys, getKeys } from './keys';
import { getChainParams } from './network';

const { subtle } = globalThis.crypto;

export type KeyStorage = {
  encryptedKeys: string;
  iv: string;
  salt: string;
  mac: string;
};

const scryptParams = {
  dkLen: 32,
  N: 262144,
  r: 8,
  p: 1,
};

export const deriveKey = async (password: string, salt: Uint8Array) => {
  return scrypt(new TextEncoder().encode(password), salt, scryptParams);
};

export const encrypt = async (data: Uint8Array, derivedKey: Uint8Array) => {
  const importedKey = await subtle.importKey('raw', derivedKey.slice(0, 16), { name: 'AES-CTR' }, false, ['encrypt']);
  const iv = randomBytes(16);

  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      {
        name: 'AES-CTR',
        counter: iv,
        length: 128,
      },
      importedKey,
      data,
    ),
  );

  return { iv, ciphertext };
};

export const decrypt = async (ciphertext: ArrayBuffer, derivedKey: Uint8Array, iv: Uint8Array) => {
  const importedKey = await subtle.importKey('raw', derivedKey.slice(0, 16), { name: 'AES-CTR' }, false, ['decrypt']);

  const decrypted = await subtle.decrypt(
    {
      name: 'AES-CTR',
      counter: iv,
      length: 128,
    },
    importedKey,
    ciphertext,
  );

  return new Uint8Array(decrypted);
};

export const encryptUsingPrivKey = (
  message: string,
  encoding: 'utf8' | 'hex' | 'base64' = 'utf8',
  pubKeys: PublicKey[],
  privateKey: PrivateKey,
) => {
  const msgBuf = Buffer.from(message, encoding);
  const encryptedMessages = pubKeys.map((keys) => keys.encrypt_message(msgBuf, privateKey));
  return encryptedMessages.map((m) => Buffer.from(m.to_bytes()).toString('base64'));
};

export const decryptUsingPrivKey = (messages: string[], privateKey: PrivateKey) => {
  let decryptedMessages: string[] = [];
  for (const message of messages) {
    const ciphertext = ECIESCiphertext.from_bytes(Buffer.from(message, 'base64'), true);
    const pubKey = ciphertext.extract_public_key();
    const decrypted = privateKey.decrypt_message(ciphertext, pubKey);
    decryptedMessages.push(Buffer.from(decrypted).toString('base64'));
  }
  return decryptedMessages;
};

export const verifyPassword = (password: string): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    if (!isPasswordRequired.value) resolve(true);
    storage.get(['salt', 'mac', 'encryptedKeys'], async (result: KeyStorage) => {
      try {
        const salt = hexToBytes(result.salt);
        const derivedKey = await deriveKey(password, salt);
        const mac = bytesToHex(generateMac(derivedKey, hexToBytes(result.encryptedKeys)));
        if (mac === result.mac) {
          resolve(true);
        } else {
          await new Promise<void>((r) => setTimeout(r, 500));
          reject(new Error('Incorrect password'));
        }
      } catch (error) {
        reject(error);
      }
    });
  });
};

const generateMac = (derivedKey: Uint8Array, encryptedKeys: Uint8Array) => {
  return keccak_256(concatBytes(derivedKey.slice(16, 32), encryptedKeys));
};

export const generateSeedAndStoreEncrypted = async (
  password: string,
  mnemonic?: string,
  walletDerivation: string | null = null,
  identityDerivation: string | null = null,
) => {
  const salt = randomBytes(32);
  const derivedKey = await deriveKey(password, salt);

  const keys = getKeys(mnemonic, walletDerivation, identityDerivation);
  const { ciphertext, iv } = await encrypt(
    new TextEncoder().encode(JSON.stringify([keys.mnemonic, keys.walletDerivationPath, keys.identityDerivationPath])),
    derivedKey,
  );
  const mac = generateMac(derivedKey, ciphertext);

  storage.set({
    encryptedKeys: bytesToHex(ciphertext),
    iv: bytesToHex(iv),
    mac: bytesToHex(mac),
    salt: bytesToHex(salt),
  });
  return keys.mnemonic;
};

export const retrieveKeys = (password?: string): Promise<Keys | Partial<Keys>> => {
  return new Promise((resolve, reject) => {
    storage.get(['encryptedKeys', 'iv', 'salt', 'mac'], async (result: KeyStorage) => {
      try {
        if (!password || !result.encryptedKeys || !result.iv || !result.mac) return;

        const derivedKey = await deriveKey(password, hexToBytes(result.salt));
        const mac = bytesToHex(generateMac(derivedKey, hexToBytes(result.encryptedKeys)));
        if (mac !== result.mac) {
          reject('Unauthorized!');
          return;
        }
        const bytes = await decrypt(hexToBytes(result.encryptedKeys), derivedKey, hexToBytes(result.iv));
        const mnemonic = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        const keys = getKeys(...mnemonic);
        const walletAddr = P2PKHAddress.from_string(keys.walletAddress).set_chain_params(getChainParams()).to_string();
        const identityAddr = P2PKHAddress.from_string(keys.identityAddress)
          .set_chain_params(getChainParams())
          .to_string();

        resolve(
          Object.assign({}, keys, {
            walletAddress: walletAddr,
            identityAddress: identityAddr,
          }),
        );
      } catch (error) {
        reject(error);
      }
    });
  });
};
