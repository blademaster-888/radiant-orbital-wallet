import { P2PKHAddress } from 'rxd-wasm';
import { logger } from '../logger';
import { RXD_DECIMAL_CONVERSION } from '../utils/constants';
import electrum from '../Electrum';
import { scriptHash } from '../utils/script';
import { unspentDiff } from '../utils/utxo';
import { Utxo, db } from '../db';
import { isAddressOnRightNetwork } from '../utils/network';

export type ChainInfo = {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  difficulty: number;
  mediantime: number;
  verificationprogress: number;
  pruned: boolean;
  chainwork: string;
};

export const useElectrum = () => {
  const getRxdBalance = async (address: string, pullFresh?: boolean): Promise<number | undefined> => {
    const utxos = await getUtxos(address, pullFresh);
    if (!utxos) return 0;

    const photons = utxos.reduce((a, item) => a + Number(item.value), 0);
    return photons / RXD_DECIMAL_CONVERSION;
  };

  const getUtxos = async (fromAddress: string, pullFresh?: boolean): Promise<Utxo[]> => {
    if (!isAddressOnRightNetwork(fromAddress)) return [];

    if (pullFresh) {
      const p2pkh = P2PKHAddress.from_string(fromAddress).get_locking_script().to_hex();
      const p2pkhScriptHash = scriptHash(p2pkh);
      const allUnspent = await electrum.listUnspent(p2pkhScriptHash);
      const { newUnspent, spent } = await unspentDiff(allUnspent, 'rxd');

      // Remove spent UTXOs
      await db.utxo.bulkDelete(spent);

      // Add new UTXOs to the DB
      for (const unspent of newUnspent) {
        db.utxo.put({
          type: 'rxd',
          txid: unspent.tx_hash,
          vout: unspent.tx_pos,
          value: BigInt(unspent.value),
        });
      }
    }

    return await db.utxo.where({ type: 'rxd' }).toArray();
  };

  const getRawTxById = async (txid: string): Promise<string | undefined> => {
    try {
      return electrum.getTransaction(txid);
    } catch (error) {
      logger.error(error);
    }
  };

  const broadcastRawTx = async (txhex: string): Promise<string | undefined> => {
    try {
      return await electrum.broadcast(txhex);
    } catch (error) {
      logger.error('broadcast rawtx failed:', error);
    }
  };

  const getSuitableUtxo = (utxos: Utxo[], minimum: number) => {
    const suitableUtxos = utxos.filter((utxo) => utxo.value > minimum);

    if (suitableUtxos.length === 0) {
      throw new Error('No UTXO large enough for this transaction');
    }
    // Select a random UTXO from the suitable ones
    const randomIndex = Math.floor(Math.random() * suitableUtxos.length);
    return suitableUtxos[randomIndex];
  };

  // TODO make UTXO types consistent
  const getInputs = <T = { value: bigint } | { satoshis: number }>(
    utxos: T[],
    satsOut: number | bigint,
    feePerInput: bigint,
    isSendAll: boolean,
  ) => {
    if (isSendAll) return utxos;
    let out = BigInt(satsOut);
    let sum = 0n;
    let index = 0;
    let inputs: T[] = [];

    while (sum <= out && index < utxos.length) {
      const utxo = utxos[index];
      const value = BigInt(
        (utxo as { value: bigint }).value === undefined
          ? (utxo as { satoshis: number }).satoshis
          : (utxo as { value: bigint }).value,
      );
      // Each added input needs to be funded
      out += feePerInput;
      sum += value;
      inputs.push(utxo);
      index++;
    }
    return inputs;
  };

  const getChainInfo = async (): Promise<ChainInfo | undefined> => {
    // TODO implement this
    return undefined;
  };

  return {
    getUtxos,
    getRxdBalance,
    getRawTxById,
    broadcastRawTx,
    getSuitableUtxo,
    getInputs,
    getChainInfo,
  };
};
