import { useState } from 'react';
import {
  ftScript,
  ftScriptSize,
  p2pkhScriptSigSize,
  p2pkhScriptSize,
  scriptHash,
  txSize,
  zeroRef,
} from '../utils/script';
import electrum, { ElectrumUtxo, batchRequests } from '../Electrum';
import { P2PKHAddress, PrivateKey, Script, SigHash, Transaction, TxIn, TxOut } from 'rxd-wasm';
import { useElectrum } from './useElectrum';
import { Token, Utxo, db } from '../db';
import { Outpoint, reverseOutpoint } from '../utils/outpoint';
import { decode } from 'cbor-x';
import { hexToBytes } from '@noble/hashes/utils';
import { putFile } from '../utils/opfs';
import { FEE_PER_BYTE, P2PKH_INPUT_SIZE } from '../utils/constants';
import { unspentDiff } from '../utils/utxo';
import { retrieveKeys, verifyPassword } from '../utils/crypto';
import { getKeys as getSessionKeys } from '../utils/keyring';
import { locked, rxdAddress } from '../signals';
import mime from 'mime';

export interface TokenData {
  initialized: boolean;
  data: TokenUtxo[];
}

export interface RadiantToken {
  type: 'nft' | 'ft';
  ref: string;
  name: string;
  desc: string;
  license: string;
}

export interface NftToken extends RadiantToken {
  type: 'nft';
}

export interface FtToken extends RadiantToken {
  type: 'ft';
  ticker: string;
}

export type TokenUtxo = ElectrumUtxo & {
  ref: string;
};

type GlyphEmbed = {
  t: string;
  b: Uint8Array;
};

const isKnownEmbed = (contentType: string) =>
  ['text/plain', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml'].includes(
    contentType || '',
  );

export const useRadiantTokens = () => {
  const { getUtxos, getInputs } = useElectrum();

  const [isProcessing, setIsProcessing] = useState(false);

  const syncUtxos = async (scriptHash: string) => {
    const unspent = await electrum.listUnspent(scriptHash);
    const { newUnspent, spent } = await unspentDiff(unspent, 'ft');
    await db.utxo.bulkDelete(spent);

    // Create an array of refs not in the database
    const newRefSet = new Set<string>();
    const refToTokenMap = new Map<string, Token>();
    // The first little-endian ref found in each script
    const refsLE = new Map<ElectrumUtxo, string>();
    for (const utxo of newUnspent) {
      const firstRef = utxo.refs[0];
      if (!firstRef || firstRef.type !== 'normal') {
        continue;
      }
      const op = Outpoint.fromUTXO(firstRef.ref.slice(0, 64), parseInt(firstRef.ref.slice(65), 10));
      const ref = op.reverse().toString();

      // Save the little-endian ref to use later
      refsLE.set(utxo, ref);

      const token = await db.token.get({ ref });
      if (token) {
        // Save the token so we can set the tokenId on the new UTXOs
        refToTokenMap.set(ref, token);
      } else {
        newRefSet.add(ref);
      }
    }
    const newRefs = Array.from(newRefSet);

    // Get mint txids
    const refRevealTxIds = await batchRequests<string, string | undefined>(newRefs, 3, async (ref) => {
      const result = await electrum.getRef(reverseOutpoint(ref));
      return [ref, result[0]?.tx_hash];
    });

    // Dedup reveal txids
    const revealTxIds = Array.from(new Set(Object.values(refRevealTxIds) as string[]));

    // Fetch reveal txs
    const revealTxs = await batchRequests<string, Transaction | undefined>(revealTxIds, 3, async (txid) => {
      const hex = await electrum.getTransaction(txid);
      return [txid, hex ? Transaction.from_hex(hex) : undefined];
    });

    const payloads = newRefs
      .map((ref) => {
        const txid = refRevealTxIds[ref];
        const reveal = txid && revealTxs[txid];
        if (!reveal) {
          return [ref, undefined];
        }

        const index = Buffer.from(ref.substring(64), 'hex').readInt32LE();
        const script = reveal.get_input(index)?.get_unlocking_script();
        if (!script) {
          return [ref, undefined];
        }
        const match = script.to_asm_string().match(/(^| )676c79 (?<payload>[0-9A-Fa-f]+)($| )/);
        if (!match?.groups?.payload) {
          return [ref, undefined];
        }

        try {
          const payload = decode(hexToBytes(match.groups.payload));
          console.log(payload);
          const ticker = payload?.ticker || '';
          const name = payload?.name;
          // Find file
          let file = undefined;
          const embed = payload?.main as GlyphEmbed;
          if (embed) {
            if (embed.b instanceof Uint8Array && embed.b.byteLength <= 1000000 && isKnownEmbed(embed.t)) {
              file = embed;
            }
          }
          return [ref, { name, ticker, file }];
        } catch {
          return [ref, undefined];
        }
      })
      .filter((_, p) => !p) as [string, { name: string; ticker: string; file?: GlyphEmbed }][];

    // Add new tokens to the DB
    for (const [ref, payload] of payloads) {
      if (!payload) continue;

      const fileExt = payload.file?.t ? mime.getExtension(payload.file.t) : '';
      const token: Token = {
        name: payload.name,
        ref,
        ticker: payload.ticker,
        type: 'ft' as const,
        balance: 0n,
        fileExt: fileExt || '',
      };

      // Save token logo file in OPFS
      if (payload.file) {
        await putFile('icon', `${ref}.${fileExt}`, payload.file.b);
      }

      try {
        const id = await db.token.put(token);
        // Save to refs map
        refToTokenMap.set(ref, { id, ...token });
      } catch (error) {
        console.log(error);
      }
    }

    // Add new UTXOs to the DB
    for (const unspent of newUnspent) {
      const ref = refsLE.get(unspent);
      const tokenId = ref && refToTokenMap.get(ref)?.id;
      if (tokenId) {
        await db.utxo.put({
          type: 'ft',
          txid: unspent.tx_hash,
          vout: unspent.tx_pos,
          value: BigInt(unspent.value),
          tokenId,
        });
      }
    }

    updateTokenBalances();
  };

  const updateTokenBalances = () => {
    // Update balances
    return db.transaction('rw', db.utxo, db.token, async () => {
      // Get all token ids to keep track of which tokens don't get updated
      const tokenIds = new Set((await db.token.toCollection().primaryKeys()) as number[]);

      // Calculate balances for all tokens
      const balances = Array.from(
        (await db.utxo.where({ type: 'ft' }).toArray()).reduce(
          (sum, { tokenId, value }) => sum.set(tokenId as number, (sum.get(tokenId as number) || 0n) + value),
          new Map<number, bigint>(),
        ),
      );

      // Update balances
      db.token.bulkUpdate(
        balances.map(([key, balance]) => {
          tokenIds.delete(key);
          return {
            key,
            changes: { balance },
          };
        }),
      );

      // Any remaining token ids must have zero balance
      db.token.bulkDelete(Array.from(tokenIds.keys()));
    });
  };

  const syncTokens = async () => {
    const ftScriptHash = scriptHash(ftScript(rxdAddress.value, zeroRef).to_hex());
    await syncUtxos(ftScriptHash);
  };

  const sendFt = async (token: Token, receiveAddress: string, amount: bigint, password: string) => {
    try {
      // When the wallet is already unlocked the keys are cached in session storage —
      // skip password re-verification and use the cached keys directly.
      const walletUnlocked = !locked.value;
      if (!walletUnlocked) {
        const isAuthenticated = await verifyPassword(password);
        if (!isAuthenticated) {
          return { error: 'invalid-password' };
        }
      }

      const tokenUtxos = await db.utxo.where({ tokenId: token.id }).toArray();
      const totalTokens = tokenUtxos.reduce((a: bigint, token: Utxo) => a + token.value, 0n);
      if (totalTokens < amount) {
        return { error: 'insufficient-funds' };
      }

      const p2pkh = P2PKHAddress.from_string(rxdAddress.value).get_locking_script();
      const tokenInputs = getInputs(tokenUtxos, amount, 0n, false);
      const totalInputTokens = tokenInputs.reduce((a, item) => a + item.value, 0n);

      const keys = walletUnlocked ? await getSessionKeys() : await retrieveKeys(password);
      if (!keys?.walletWif || !keys.walletPubKey) throw Error('Undefined key');
      const paymentPk = PrivateKey.from_wif(keys.walletWif);

      const outputSizes = [ftScriptSize];
      const tx = new Transaction(1, 0);
      const outToken1 = new TxOut(amount, ftScript(receiveAddress, token.ref));
      tx.add_output(outToken1);
      const tokenChange = totalInputTokens - amount;
      if (tokenChange > 0n) {
        outputSizes.push(ftScriptSize);
        const outToken2 = new TxOut(tokenChange, ftScript(rxdAddress.value, token.ref));
        tx.add_output(outToken2);
      }

      // Funding change output
      outputSizes.push(p2pkhScriptSize);

      const inputSizes = tokenInputs.map(() => p2pkhScriptSigSize);
      const unfundedTxFee = txSize(inputSizes, outputSizes) * FEE_PER_BYTE;
      const fundingUtxos = await getUtxos(rxdAddress.value);

      const totalSats = fundingUtxos.reduce((a: number, item: Utxo) => a + Number(item.value), 0);
      if (totalSats < unfundedTxFee) {
        return { error: 'insufficient-funds' };
      }
      const feePerInput = BigInt(P2PKH_INPUT_SIZE * FEE_PER_BYTE);
      const fundingInputs = getInputs(fundingUtxos, unfundedTxFee, feePerInput, false);
      const totalInputSats = fundingInputs.reduce((a, item) => a + Number(item.value), 0);

      inputSizes.push(...fundingInputs.map(() => p2pkhScriptSigSize));

      const txFee = txSize(inputSizes, outputSizes) * FEE_PER_BYTE;
      const change = totalInputSats - txFee;
      const newOutputs: Partial<Utxo>[] = [];
      if (change > 0) {
        tx.add_output(new TxOut(BigInt(change), p2pkh));
        newOutputs.push({
          vout: tx.get_noutputs() - 1,
          value: BigInt(change),
        });
      }

      tokenInputs.forEach((tokenInput, inputIndex) => {
        const inToken = new TxIn(hexToBytes(tokenInput.txid), tokenInput.vout, Script.from_hex(''));
        inToken.set_satoshis(tokenInput.value);
        tx.add_input(inToken);
        tx.set_input(inputIndex, inToken);
      });

      let idx = tokenInputs.length;
      for (let u of fundingInputs || []) {
        const inTx = new TxIn(hexToBytes(u.txid), u.vout, Script.from_hex(''));
        inTx.set_satoshis(BigInt(u.value));
        tx.add_input(inTx);
        tx.set_input(idx, inTx);
        idx++;
      }

      // Sign token inputs
      tokenInputs.forEach((tokenInput, inputIndex) => {
        const sig = tx.sign(
          paymentPk,
          SigHash.InputsOutputs,
          inputIndex,
          ftScript(rxdAddress.value, token.ref),
          tokenInput.value,
        );
        const txIn = tx.get_input(inputIndex) as TxIn;
        txIn?.set_unlocking_script(Script.from_asm_string(`${sig.to_hex()} ${paymentPk.to_public_key().to_hex()}`));
        tx.set_input(inputIndex, txIn);
      });

      // Sign funding inputs
      fundingInputs.forEach((fundingInput, inputIndex) => {
        const idx = inputIndex + tokenInputs.length;
        const sig = tx.sign(paymentPk, SigHash.InputsOutputs, idx, p2pkh, fundingInput.value);
        const txIn = tx.get_input(idx) as TxIn;
        txIn.set_unlocking_script(Script.from_asm_string(`${sig.to_hex()} ${paymentPk.to_public_key().to_hex()}`));
        tx.set_input(idx, txIn);
      });

      const rawtx = tx.to_hex();
      console.log(`Tx size ${tx.get_size()} fee ${txFee} fee per byte ${txFee / tx.get_size()}`);
      console.log('FT rawtx:', rawtx);
      let txid: string | undefined;
      try {
        txid = await electrum.broadcast(rawtx);
      } catch (broadcastErr: any) {
        const msg = broadcastErr?.message ?? broadcastErr?.toString() ?? 'broadcast-error';
        console.error('Broadcast rejected:', msg);
        throw new Error(msg);
      }
      if (!txid) throw new Error('broadcast-error');

      // Update UTXOs in DB
      await db.transaction('rw', db.utxo, async () => {
        // Update FT UTXOs
        await db.utxo.bulkDelete(tokenInputs.map((u) => u.id));

        if (tokenChange > 0n) {
          const changeUtxo = { ...tokenInputs[0], txid: txid!, vout: 1, value: BigInt(tokenChange) };
          await db.utxo.put(changeUtxo);
        }

        // Update RXD funding UTXOs
        await db.utxo.bulkDelete(fundingInputs.map((u) => u.id));
        await db.utxo.bulkAdd(newOutputs.map((u) => ({ ...u, txid, type: 'rxd' }) as Utxo));
      });

      updateTokenBalances();

      return { txid, error: '' };
    } catch (error) {
      console.log(error);
      return { txid: null, error: (error as Error).message ?? 'broadcast-error' };
    }
  };
  const getTokenPriceInSats = () => {};

  return {
    syncTokens,
    isProcessing,
    setIsProcessing,
    sendFt,
    getTokenPriceInSats,
  };
};
