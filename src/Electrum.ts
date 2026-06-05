import { ElectrumWS } from 'ws-electrumx-client';

export type ElectrumUtxo = {
  height: number;
  tx_hash: string;
  tx_pos: number;
  value: number;
  refs: { ref: string; type: 'normal' | 'singleton' }[];
};

export type RefLocation = {
  tx_hash: string;
  height: number;
};

class Electrum {
  public endpoint?: string;
  public client?: ElectrumWS;

  public async getTransaction(txid: string) {
    return this.client?.request('blockchain.transaction.get', txid) as Promise<string>;
  }

  public async listUnspent(scriptHash: string) {
    return this.client?.request('blockchain.scripthash.listunspent', scriptHash) as Promise<ElectrumUtxo[]>;
  }

  public async getRef(refBE: string) {
    return this.client?.request('blockchain.ref.get', refBE) as Promise<[RefLocation, RefLocation]>;
  }

  public async broadcast(hex: string) {
    return this.client?.request('blockchain.transaction.broadcast', hex) as Promise<string>;
  }

  public connected(): boolean {
    return !!this.client && this.client.isConnected();
  }

  public events: [string, (...args: unknown[]) => void][] = [];

  public addEvent(eventName: string, callback: (...args: unknown[]) => void) {
    this.events.push([eventName, callback]);
  }

  public changeEndpoint(endpoint: string): boolean {
    if (this.connected() && this.client) {
      this.client.close('');
    }
    this.endpoint = endpoint;
    try {
      this.client = new ElectrumWS(endpoint);
    } catch (error) {
      return false;
    }

    this.events.forEach(([eventName, callback]) => {
      this.client?.on(eventName, callback);
    });

    return true;
  }

  public reconnect() {
    if (this.endpoint) {
      return this.changeEndpoint(this.endpoint);
    }
    return false;
  }

  public disconnect(reason = '') {
    if (this.client) {
      this.client.close(reason);
    }
  }
}

export function arrayChunks<T = unknown>(arr: T[], chunkSize: number) {
  const chunks = [];

  for (let i = 0; i < arr.length; i += chunkSize) {
    const chunk = arr.slice(i, i + chunkSize);
    chunks.push(chunk);
  }

  return chunks;
}

export async function batchRequests<ParamType, ValueType>(
  params: ParamType[],
  batchSize: number,
  callback: (param: ParamType) => Promise<[string, ValueType | undefined]>,
) {
  const paramBatches = arrayChunks(Array.from(params), batchSize);
  const responseBatches = [];
  for (const paramBatch of paramBatches) {
    responseBatches.push(await Promise.all(paramBatch.map(callback)));
  }
  return Object.fromEntries(responseBatches.flat().filter(([, v]) => v)) as {
    [key: string]: ValueType;
  };
}

const electrum = new Electrum();
electrum.changeEndpoint('wss://electrumx.radiant4people.com:50022');
export default electrum;
