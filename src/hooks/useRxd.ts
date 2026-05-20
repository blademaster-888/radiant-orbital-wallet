import {
  BSM,
  P2PKHAddress,
  PrivateKey,
  PublicKey,
  Script,
  SigHash,
  Signature,
  Transaction,
  TxIn,
  TxOut,
} from 'rxd-wasm';
import { useEffect, useState } from 'react';
import { SignMessageResponse } from '../pages/requests/SignMessageRequest';
import { logger } from '../logger';
import { RXD_DECIMAL_CONVERSION, FEE_PER_BYTE, MAX_BYTES_PER_TX, MAX_FEE_PER_TX } from '../utils/constants';
import { DerivationTag, getPrivateKeyFromTag, Keys } from '../utils/keys';
import { getChainParams } from '../utils/network';
import { storage } from '../utils/storage';
import { useElectrum } from './useElectrum';
import { p2pkhScriptSigSize, p2pkhScriptSize, txSize } from '../utils/script';
import { getExchangeRate } from '../getExchangeRate';
import { Utxo, db } from '../db';
import { retrieveKeys, verifyPassword } from '../utils/crypto';
import { rxdAddress } from '../signals';
import { getKeys, unlock } from '../utils/keyring';
import { hexToBytes } from '@noble/hashes/utils';
import { useSignals } from '@preact/signals-react/runtime';
import { effect } from '@preact/signals-react';
import { locked } from '../signals';

type SendRxdResponse = {
  txid?: string;
  rawtx?: string;
  error?: string;
};

type FundRawTxResponse = { rawtx?: string; error?: string };

export type Web3SendRxdRequest = {
  satoshis: number;
  address?: string;
  data?: string[]; // hex string array
  script?: string; // hex string
}[];

export type Web3BroadcastRequest = {
  rawtx: string;
  fund?: boolean;
};

export type Web3SignMessageRequest = {
  message: string;
  encoding?: 'utf8' | 'hex' | 'base64';
  tag?: DerivationTag;
};

export type Web3EncryptRequest = {
  message: string;
  pubKeys: string[];
  encoding?: 'utf8' | 'hex' | 'base64';
  tag?: DerivationTag;
};

export type Web3DecryptRequest = {
  messages: string[];
  tag?: DerivationTag;
};

export const useRxd = () => {
  useSignals();
  const [rxdBalance, setRxdBalance] = useState(0);
  const [exchangeRate, setExchangeRate] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const { broadcastRawTx, getUtxos, getRxdBalance, getInputs } = useElectrum();

  const sendRxd = async (
    request: Web3SendRxdRequest,
    password: string,
    noApprovalLimit?: number,
  ): Promise<SendRxdResponse> => {
    try {
      setIsProcessing(true);
      const requestSats = request.reduce((a: number, item: { satoshis: number }) => a + item.satoshis, 0);
      const rxdSendAmount = requestSats / RXD_DECIMAL_CONVERSION;
      const isBelowNoApprovalLimit = Number(rxdSendAmount) <= Number(noApprovalLimit);

      if (!isBelowNoApprovalLimit) {
        const isAuthenticated = await unlock(password);
        if (!isAuthenticated) {
          return { error: 'invalid-password' };
        }
      }

      const keys = await getKeys();
      if (!keys?.walletWif || !keys.walletPubKey) throw Error('Undefined key');
      const paymentPk = PrivateKey.from_wif(keys.walletWif);
      const pubKey = paymentPk.to_public_key();
      const fromAddress = pubKey.to_address().set_chain_params(getChainParams()).to_string();
      const amount = request.reduce((a, r) => a + r.satoshis, 0);
      const p2pkh = P2PKHAddress.from_string(rxdAddress.value).get_locking_script();

      // Format in and outs
      const fundingUtxos = await getUtxos(fromAddress);

      if (!fundingUtxos) throw Error('No Utxos!');
      const totalSats = fundingUtxos.reduce((a: number, item: Utxo) => a + Number(item.value), 0);

      if (totalSats < amount) {
        return { error: 'insufficient-funds' };
      }

      const sendAll = totalSats === amount;
      if (sendAll) {
        logger.log(`Sending all ${totalSats}`);
      }
      const outputSizes = request.map((req) => {
        if (req.address) return p2pkhScriptSize;
        if (req.script) return req.script.length / 2;
        if (req.data?.length) return 2 + req.data.join('').length / 2;
        throw Error('Invalid request');
      });

      // Change
      if (!sendAll) {
        outputSizes.push(p2pkhScriptSize);
      }

      const baseTxFee = txSize([], outputSizes) * FEE_PER_BYTE;
      const feePerInput = BigInt(p2pkhScriptSigSize * FEE_PER_BYTE);
      const inputs = getInputs(fundingUtxos, amount + baseTxFee, feePerInput, sendAll);

      let feeSats =
        txSize(
          inputs.map(() => p2pkhScriptSigSize),
          outputSizes,
        ) * FEE_PER_BYTE;

      const satsOut = sendAll ? totalSats - feeSats : amount;

      const totalInputSats = inputs.reduce((a, item) => a + Number(item.value), 0);

      // Build tx
      const tx = new Transaction(1, 0);
      const newOutputs: Partial<Utxo>[] = [];

      request.forEach((req, outputIndex) => {
        let outScript: Script = Script.from_hex('');
        if (req.address) {
          outScript = P2PKHAddress.from_string(req.address).get_locking_script();
        } else if (req.script) {
          outScript = Script.from_hex(req.script);
        } else if ((req.data || []).length > 0) {
          let asm = `OP_0 OP_RETURN ${req.data?.join(' ')}`;
          try {
            outScript = Script.from_asm_string(asm);
          } catch (e) {
            throw Error('Invalid data');
          }
        } else {
          throw Error('Invalid request');
        }
        // TODO: In event where provider method calls this and happens to have multiple outputs that equal all sats available in users wallet, this tx will likely fail due to no fee to miner. Considering an edge case for now.
        const outSats = sendAll && request.length === 1 ? satsOut : req.satoshis;
        tx.add_output(new TxOut(BigInt(outSats), outScript));

        // If sending to own wallet, save this output to update in local storage later
        if (req.address === rxdAddress.value) {
          newOutputs.push({
            vout: outputIndex,
            value: BigInt(outSats),
          });
        }
      });

      let change = 0;
      if (!sendAll) {
        change = totalInputSats - satsOut - feeSats;
        const outScript = P2PKHAddress.from_string(fromAddress).get_locking_script();
        tx.add_output(new TxOut(BigInt(change), outScript));
        newOutputs.push({
          vout: request.length,
          value: BigInt(change),
        });
      }

      // build txins from our inputs
      let idx = 0;
      for (let u of inputs || []) {
        const inTx = new TxIn(hexToBytes(u.txid), u.vout, Script.from_hex(''));

        inTx.set_satoshis(u.value);
        tx.add_input(inTx);

        const sig = tx.sign(paymentPk, SigHash.InputOutputs, idx, p2pkh, u.value);

        inTx.set_unlocking_script(Script.from_asm_string(`${sig.to_hex()} ${paymentPk.to_public_key().to_hex()}`));
        tx.set_input(idx, inTx);
        idx++;
      }

      // Fee checker
      const finalSatsIn = tx.satoshis_in() ?? 0n;
      const finalSatsOut = tx.satoshis_out() ?? 0n;
      if (finalSatsIn - finalSatsOut > MAX_FEE_PER_TX) return { error: 'fee-too-high' };

      // Size checker
      const bytes = tx.to_bytes().byteLength;
      if (bytes > MAX_BYTES_PER_TX) return { error: 'tx-size-too-large' };

      const rawtx = tx.to_hex();
      let txid = await broadcastRawTx(rawtx);
      logger.log(rawtx);
      logger.log(`Tx size ${tx.get_size()} fee ${feeSats} fee per byte ${feeSats / tx.get_size()}`);
      if (txid) {
        if (isBelowNoApprovalLimit) {
          storage.get(['noApprovalLimit'], ({ noApprovalLimit }) => {
            storage.set({
              noApprovalLimit: noApprovalLimit
                ? Number((noApprovalLimit - amount / RXD_DECIMAL_CONVERSION).toFixed(8))
                : 0,
            });
          });
        }

        // Update UTXOs in database
        db.transaction('rw', db.utxo, () => {
          db.utxo.bulkDelete(fundingUtxos.map((u) => u.id));
          db.utxo.bulkAdd(newOutputs.map((u) => ({ ...u, txid, type: 'rxd' }) as Utxo));
        });
      }

      return { txid, rawtx };
    } catch (error: any) {
      logger.error(error);
      return { error: error.message ?? 'unknown' };
    } finally {
      setIsProcessing(false);
    }
  };

  const signMessage = async (
    messageToSign: Web3SignMessageRequest,
    password: string,
  ): Promise<SignMessageResponse | undefined> => {
    const { message, encoding } = messageToSign;
    let keys: Keys;
    if (!locked.value) {
      const k = await getKeys();
      if (!k) return { error: 'invalid-password' };
      keys = k as Keys;
    } else {
      const isAuthenticated = await verifyPassword(password);
      if (!isAuthenticated) return { error: 'invalid-password' };
      keys = (await retrieveKeys(password)) as Keys;
    }
    try {
      const derivationTag = messageToSign.tag ?? { label: 'orbital', id: 'rxd', domain: '', meta: {} };
      const privateKey = getPrivateKeyFromTag(derivationTag, keys);

      if (!privateKey.to_wif()) {
        return { error: 'key-type' };
      }

      const publicKey = privateKey.to_public_key();
      const address = publicKey.to_address().set_chain_params(getChainParams()).to_string();

      const msgBuf = Buffer.from(message, encoding);
      const signature = BSM.sign_message(privateKey, msgBuf);
      return {
        address,
        pubKey: publicKey.to_hex(),
        message: message,
        sig: Buffer.from(signature.to_compact_hex(), 'hex').toString('base64'),
        derivationTag,
      };
    } catch (error) {
      logger.error(error);
    }
  };

  const verifyMessage = (
    message: string,
    signatureHex: string,
    publicKeyHex: string,
    encoding: 'utf8' | 'hex' | 'base64' = 'utf8',
  ) => {
    try {
      const msgBuf = Buffer.from(message, encoding);
      const publicKey = PublicKey.from_hex(publicKeyHex);
      const signature = Signature.from_compact_bytes(hexToBytes(signatureHex));
      const address = publicKey.to_address().set_chain_params(getChainParams());

      return address.verify_bitcoin_message(msgBuf, signature);
    } catch (error) {
      logger.error(error);
      return false;
    }
  };

  const updateRxdBalance = async (pullFresh?: boolean) => {
    const total = await getRxdBalance(rxdAddress.value, pullFresh);
    setRxdBalance(total ?? 0);
  };

  const rate = async () => {
    const r = await getExchangeRate();
    setExchangeRate(r ?? 0);
  };

  const fundRawTx = async (rawtx: string, password: string): Promise<FundRawTxResponse> => {
    const isAuthenticated = await verifyPassword(password);
    if (!isAuthenticated) {
      return { error: 'invalid-password' };
    }
    return { error: '' };
    // TODO

    /*
    const keys = await retrieveKeys(password);
    if (!keys.walletWif) throw new Error('Missing keys');
    const paymentPk = PrivateKey.from_wif(keys.walletWif);

    let satsIn = 0;
    let satsOut = 0;
    const tx = Transaction.from_hex(rawtx);
    let inputCount = tx.get_ninputs();
    for (let i = 0; i < inputCount; i++) {
      const txIn = tx.get_input(i);
      const txOut = await getTxOut(txIn!.get_prev_tx_id_hex(), txIn!.get_vout());
      satsIn += Number(txOut!.get_satoshis());
    }
    for (let i = 0; i < tx.get_noutputs(); i++) {
      satsOut += Number(tx.get_output(i)!.get_satoshis()!);
    }
    let size = rawtx.length / 2 + P2PKH_OUTPUT_SIZE;
    let fee = Math.ceil(size * FEE_PER_BYTE);
    const fundingUtxos = await getUtxos(rxdAddress);
    while (satsIn < satsOut + fee) {
      const utxo = fundingUtxos.pop();
      if (!utxo) throw Error('Insufficient funds');
      const txIn = new TxIn(Buffer.from(utxo.txid, 'hex'), utxo.vout, Script.from_hex(''));
      tx.add_input(txIn);
      satsIn += Number(utxo.satoshis);
      size += P2PKH_INPUT_SIZE;
      fee = Math.ceil(size * FEE_PER_BYTE);
      const sig = tx.sign(paymentPk, SigHash.Input, inputCount, Script.from_hex(utxo.script), BigInt(utxo.satoshis));
      txIn.set_unlocking_script(Script.from_asm_string(`${sig.to_hex()} ${paymentPk.to_public_key().to_hex()}`));
      tx.set_input(inputCount++, txIn);
    }
    tx.add_output(new TxOut(BigInt(satsIn - satsOut - fee), P2PKHAddress.from_string(rxdAddress).get_locking_script()));
    return { rawtx: tx.to_hex() };
    */
  };

  useEffect(() => {
    effect(() => {
      if (!rxdAddress.value) return;
      updateRxdBalance();
      rate();
    });
  });

  return {
    rxdBalance,
    isProcessing,
    sendRxd,
    setIsProcessing,
    updateRxdBalance,
    exchangeRate,
    signMessage,
    verifyMessage,
    fundRawTx,
    retrieveKeys,
    getChainParams,
  };
};
