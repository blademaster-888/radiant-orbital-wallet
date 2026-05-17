import { useState } from 'react';
import {
  ftScript,
  ftScriptSize,
  p2pkhScriptSigSize,
  p2pkhScriptSize,
  parseFtScript,
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
      .filter(([, payload]) => payload !== undefined) as [string, { name: string; ticker: string; file?: GlyphEmbed }][];

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

  // Convert "txid_BE:vout_decimal" → Dexie ref (txid_LE + vout_LE_8hex)
  function colonToRef(colonRef: string): string {
    try {
      const colon = colonRef.indexOf(':');
      if (colon === -1) return colonRef;
      const txidBE = colonRef.slice(0, colon);
      const vout   = parseInt(colonRef.slice(colon + 1), 10);
      const txidLE = Buffer.from(txidBE, 'hex').reverse().toString('hex');
      const voutBuf = Buffer.alloc(4);
      voutBuf.writeUInt32LE(vout);
      return `${txidLE}${voutBuf.toString('hex')}`;
    } catch {
      return colonRef;
    }
  }

  // SIGHASH_SINGLE | ANYONECANPAY | FORKID = 3 | 128 | 64 = 195
  // Seller signs their input committing only to the payment output at the same index.
  // Buyer can freely add inputs and the remaining outputs without breaking this sig.
  const SIGHASH_SWAP_OFFER = (SigHash.SINGLE | SigHash.ANYONECANPAY | SigHash.FORKID) as unknown as SigHash;

  // Step 1 of PSBT atomic swap: seller pre-splits their token UTXO to exactly
  // offerAmount (via sendFt-to-self), then constructs a partial tx:
  //   Input[0]: the exact-amount UTXO, signed with ANYONECANPAY|SINGLE
  //   Output[0]: wantAmount of wantToken → sellerAddr (locked payment commitment)
  // Returns the partial rawtx hex for storage in the listing.
  const createSwapOffer = async (params: {
    offerTokenRef: string;     // "txid_BE:vout_decimal" from the market
    offerTokenTicker?: string;
    offerAmount: bigint;
    wantTokenRef: string;      // "txid_BE:vout_decimal" from the market
    wantTokenTicker?: string;
    wantAmount: bigint;
    password: string;
  }): Promise<{ partialRawtx: string } | { error: string }> => {
    try {
      const offerDexieRef = colonToRef(params.offerTokenRef);
      const wantDexieRef  = colonToRef(params.wantTokenRef);

      // Locate offer token in Dexie (with ticker fallback for cross-indexer refs)
      let offerToken = await db.token.get({ ref: offerDexieRef });
      if (!offerToken && params.offerTokenTicker) {
        const all = await db.token.toArray();
        offerToken = all.find(t => t.ticker.toUpperCase() === params.offerTokenTicker!.toUpperCase());
      }
      if (!offerToken) return { error: 'offer-token-not-found' };

      // Locate want token in Dexie so we know its electrum-derived ref (avoids
      // cross-indexer mismatch in the output script the buyer must match).
      let wantToken = await db.token.get({ ref: wantDexieRef });
      if (!wantToken && params.wantTokenTicker) {
        const all = await db.token.toArray();
        wantToken = all.find(t => t.ticker.toUpperCase() === params.wantTokenTicker!.toUpperCase());
      }
      if (!wantToken) return { error: 'want-token-not-found' };

      const offerUtxos = await db.utxo.where({ tokenId: offerToken.id }).toArray();
      const totalOffer = offerUtxos.reduce((a, u) => a + u.value, 0n);
      if (totalOffer < params.offerAmount) return { error: 'insufficient-funds' };

      const walletUnlocked = !locked.value;
      if (!walletUnlocked) {
        const ok = await verifyPassword(params.password);
        if (!ok) return { error: 'invalid-password' };
      }
      const keys = walletUnlocked ? await getSessionKeys() : await retrieveKeys(params.password);
      if (!keys?.walletWif) throw new Error('undefined-key');
      const privKey = PrivateKey.from_wif(keys.walletWif);

      // Pre-split: send exactly offerAmount tokens to self, creating a UTXO with
      // precisely that value so the partial tx has no seller token-change output
      // that the buyer could redirect. sendFt tracks vout=1 (change); vout=0 is
      // the "sent" output we'll use below — not in Dexie but valid on-chain.
      const split = await sendFt(offerToken, rxdAddress.value, params.offerAmount, params.password);
      if (!split.txid || split.error) return { error: split.error || 'pre-split-failed' };

      const sellerAddr = rxdAddress.value;
      const offerRef   = offerToken.ref;   // Dexie format (txid_LE + vout_LE_8hex)
      const wantRef    = wantToken.ref;    // Dexie format — consistent ref for both wallets

      // Build partial transaction
      const tx = new Transaction(1, 0);

      // Input[0]: pre-split vout=0 — exactly offerAmount tokens
      const sellerTxIn = new TxIn(hexToBytes(split.txid), 0, Script.from_hex(''));
      sellerTxIn.set_satoshis(params.offerAmount);
      sellerTxIn.set_locking_script(ftScript(sellerAddr, offerRef));
      tx.add_input(sellerTxIn);
      tx.set_input(0, sellerTxIn);

      // Output[0]: payment to seller — committed by ANYONECANPAY|SINGLE signature
      tx.add_output(new TxOut(params.wantAmount, ftScript(sellerAddr, wantRef)));

      // Sign Input[0] with SIGHASH_SINGLE|ANYONECANPAY|FORKID (195)
      const sig = tx.sign(privKey, SIGHASH_SWAP_OFFER, 0, ftScript(sellerAddr, offerRef), params.offerAmount);
      sellerTxIn.set_unlocking_script(
        Script.from_asm_string(`${sig.to_hex()} ${privKey.to_public_key().to_hex()}`),
      );
      tx.set_input(0, sellerTxIn);

      return { partialRawtx: tx.to_hex() };
    } catch (err) {
      console.error('[createSwapOffer]', err);
      return { error: (err as Error)?.message ?? 'unknown' };
    }
  };

  // Step 2 of PSBT atomic swap: buyer completes the seller's partial tx atomically.
  //   Adds: Input[1..] = buyer's wantToken UTXOs + RXD fee inputs
  //   Adds: Output[1] = offerAmount offerToken → buyerAddr
  //         Output[2] = wantToken change → buyerAddr (if needed)
  //         Output[3] = RXD change → buyerAddr
  // Signs buyer inputs with SIGHASH_ALL. Broadcasts the complete atomic tx.
  const completeSwapOffer = async (params: {
    partialRawtx: string;
    offerTokenRef: string;    // "txid_BE:vout_decimal" — what buyer receives
    offerTokenTicker?: string;
    offerAmount: bigint;
    wantTokenRef: string;     // "txid_BE:vout_decimal" — what buyer pays
    wantTokenTicker?: string;
    wantAmount: bigint;
    sellerAddress: string;
    password: string;
  }): Promise<{ txid: string } | { error: string }> => {
    try {
      const buyerAddr = rxdAddress.value;

      // Parse the partial tx to extract seller's signed input and payment output
      const partialTx = Transaction.from_hex(params.partialRawtx);
      const sellerInputRaw = partialTx.get_input(0);
      const paymentOutput  = partialTx.get_output(0);
      if (!sellerInputRaw || !paymentOutput) return { error: 'invalid-partial-tx' };

      // Extract the exact wantRef from the payment output script (ensures both
      // wallets use the same electrum-derived ref — no cross-indexer mismatch).
      const paymentScriptHex = paymentOutput.get_script_pub_key().to_hex();
      const { ref: wantRefFromScript } = parseFtScript(paymentScriptHex);
      if (!wantRefFromScript) return { error: 'invalid-partial-tx' };

      // Derive offerRef by fetching the seller's pre-split UTXO from the chain.
      // colonToRef(params.offerTokenRef) is unreliable because the market stores
      // refs in indexer format (e.g. txid+"i"+vout) which may differ from the
      // Dexie raw-ref format used in the UTXO locking_script — causing code-19.
      const prevTxIdHex  = Buffer.from(sellerInputRaw.get_prev_tx_id() as Uint8Array).toString('hex');
      const prevTxHex    = await electrum.getTransaction(prevTxIdHex);
      if (!prevTxHex) return { error: 'invalid-partial-tx' };
      const prevTxParsed = Transaction.from_hex(prevTxHex);
      const sellerVout   = sellerInputRaw.get_vout() as number;
      const sellerUtxoOut = prevTxParsed.get_output(sellerVout);
      if (!sellerUtxoOut) return { error: 'invalid-partial-tx' };
      const { ref: offerDexieRef } = parseFtScript(sellerUtxoOut.get_script_pub_key().to_hex());
      if (!offerDexieRef) return { error: 'invalid-partial-tx' };

      // Locate buyer's want token by the exact ref from the partial tx
      let wantToken = await db.token.get({ ref: wantRefFromScript });
      if (!wantToken && params.wantTokenTicker) {
        const all = await db.token.toArray();
        wantToken = all.find(t => t.ticker.toUpperCase() === params.wantTokenTicker!.toUpperCase());
      }
      if (!wantToken) return { error: 'payment-token-not-found' };

      const wantUtxos  = await db.utxo.where({ tokenId: wantToken.id }).toArray();
      const totalWant  = wantUtxos.reduce((a, u) => a + u.value, 0n);
      if (totalWant < params.wantAmount) return { error: 'insufficient-funds' };

      const walletUnlocked = !locked.value;
      if (!walletUnlocked) {
        const ok = await verifyPassword(params.password);
        if (!ok) return { error: 'invalid-password' };
      }
      const keys = walletUnlocked ? await getSessionKeys() : await retrieveKeys(params.password);
      if (!keys?.walletWif) throw new Error('undefined-key');
      const privKey = PrivateKey.from_wif(keys.walletWif);

      // Select buyer's payment inputs
      const buyerWantInputs = getInputs(wantUtxos, params.wantAmount, 0n, false);
      const totalBuyerWant  = buyerWantInputs.reduce((a, u) => a + u.value, 0n);
      const wantChange      = totalBuyerWant - params.wantAmount;

      // Determine output count for fee calculation
      const hasWantChange = wantChange > 0n;
      const outputSizes = [
        ftScriptSize,                         // Output[0]: payment to seller (from partial)
        ftScriptSize,                         // Output[1]: offer tokens to buyer
        ...(hasWantChange ? [ftScriptSize] : []),  // Output[2]: want change
        p2pkhScriptSize,                      // Output[3]: RXD change
      ];
      const baseSizes = [
        p2pkhScriptSigSize,                   // Input[0]: seller (ANYONECANPAY, already signed)
        ...buyerWantInputs.map(() => p2pkhScriptSigSize),
      ];

      const unfundedFee = txSize(baseSizes, outputSizes) * FEE_PER_BYTE;
      const fundingUtxos = await getUtxos(buyerAddr);
      const totalRxd = fundingUtxos.reduce((a, u) => a + Number(u.value), 0);
      if (totalRxd < unfundedFee) return { error: 'insufficient-funds' };

      const feePerInput  = BigInt(P2PKH_INPUT_SIZE * FEE_PER_BYTE);
      const fundingInputs = getInputs(fundingUtxos, unfundedFee, feePerInput, false);
      const allInputSizes = [...baseSizes, ...fundingInputs.map(() => p2pkhScriptSigSize)];
      const txFee        = txSize(allInputSizes, outputSizes) * FEE_PER_BYTE;
      const totalFunding = fundingInputs.reduce((a, u) => a + Number(u.value), 0);
      const rxdChange    = totalFunding - txFee;

      // Build the complete transaction
      const tx = new Transaction(1, 0);
      const p2pkh = P2PKHAddress.from_string(buyerAddr).get_locking_script();

      // Input[0]: seller's pre-split UTXO — reconstruct with seller's sig preserved
      const sellerTxIn = new TxIn(
        sellerInputRaw.get_prev_tx_id(),
        sellerInputRaw.get_vout(),
        sellerInputRaw.get_unlocking_script(),
      );
      sellerTxIn.set_satoshis(params.offerAmount);
      sellerTxIn.set_locking_script(ftScript(params.sellerAddress, offerDexieRef));
      tx.add_input(sellerTxIn);
      tx.set_input(0, sellerTxIn);

      // Input[1..n]: buyer's want token inputs
      buyerWantInputs.forEach((u, i) => {
        const txIn = new TxIn(hexToBytes(u.txid), u.vout, Script.from_hex(''));
        txIn.set_satoshis(u.value);
        txIn.set_locking_script(ftScript(buyerAddr, wantToken!.ref));
        tx.add_input(txIn);
        tx.set_input(1 + i, txIn);
      });

      // Output[0]: payment to seller (carried from partial tx)
      tx.add_output(paymentOutput);
      // Output[1]: seller's tokens to buyer
      tx.add_output(new TxOut(params.offerAmount, ftScript(buyerAddr, offerDexieRef)));
      // Output[2]: buyer's want token change (if any)
      if (hasWantChange) tx.add_output(new TxOut(wantChange, ftScript(buyerAddr, wantToken!.ref)));

      // RXD funding inputs
      const wantCount = buyerWantInputs.length;
      fundingInputs.forEach((u, i) => {
        const txIn = new TxIn(hexToBytes(u.txid), u.vout, Script.from_hex(''));
        txIn.set_satoshis(BigInt(u.value));
        tx.add_input(txIn);
        tx.set_input(1 + wantCount + i, txIn);
      });

      // Output[3]: RXD change
      if (rxdChange > 0) tx.add_output(new TxOut(BigInt(rxdChange), p2pkh));

      // Sign buyer's want token inputs (SIGHASH_ALL)
      buyerWantInputs.forEach((u, i) => {
        const idx = 1 + i;
        const sig = tx.sign(privKey, SigHash.InputsOutputs, idx, ftScript(buyerAddr, wantToken!.ref), u.value);
        const txIn = tx.get_input(idx) as TxIn;
        txIn.set_unlocking_script(Script.from_asm_string(`${sig.to_hex()} ${privKey.to_public_key().to_hex()}`));
        tx.set_input(idx, txIn);
      });

      // Sign RXD funding inputs (SIGHASH_ALL)
      fundingInputs.forEach((u, i) => {
        const idx = 1 + wantCount + i;
        const sig = tx.sign(privKey, SigHash.InputsOutputs, idx, p2pkh, BigInt(u.value));
        const txIn = tx.get_input(idx) as TxIn;
        txIn.set_unlocking_script(Script.from_asm_string(`${sig.to_hex()} ${privKey.to_public_key().to_hex()}`));
        tx.set_input(idx, txIn);
      });

      const rawtx = tx.to_hex();
      console.log('[completeSwapOffer] broadcasting', rawtx.slice(0, 40), '...');
      let txid: string | undefined;
      try {
        txid = await electrum.broadcast(rawtx);
      } catch (err: any) {
        throw new Error(err?.message ?? 'broadcast-error');
      }
      if (!txid) throw new Error('broadcast-error');

      // Update buyer's Dexie — remove spent UTXOs; new tokens appear on next sync
      await db.transaction('rw', db.utxo, async () => {
        await db.utxo.bulkDelete(buyerWantInputs.map(u => u.id));
        await db.utxo.bulkDelete(fundingInputs.map(u => u.id));
        if (rxdChange > 0) {
          const changeVout = hasWantChange ? 3 : 2;
          await db.utxo.add({ txid, vout: changeVout, value: BigInt(rxdChange), type: 'rxd' } as any);
        }
      });
      updateTokenBalances();

      return { txid };
    } catch (err) {
      console.error('[completeSwapOffer]', err);
      return { error: (err as Error)?.message ?? 'unknown' };
    }
  };

  return {
    syncTokens,
    isProcessing,
    setIsProcessing,
    sendFt,
    createSwapOffer,
    completeSwapOffer,
    getTokenPriceInSats,
  };
};
