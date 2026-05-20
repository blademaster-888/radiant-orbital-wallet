import { storage } from './utils/storage';
import { logger } from './logger';

export const getExchangeRate = async (): Promise<number | undefined> => {
  return new Promise((resolve, reject) => {
    storage.get(['exchangeRateCache'], async ({ exchangeRateCache }) => {
      try {
        if (exchangeRateCache?.rate && Date.now() - exchangeRateCache.timestamp < 10 * 60 * 1000) {
          resolve(Number(exchangeRateCache.rate));
        } else {
          const res = await fetch('https://api.coinpaprika.com/v1/coins/rxd-radiant/ohlcv/today');
          const obj = await res.json();
          const rate = obj[0]?.close || 0;
          const currentTime = Date.now();
          storage.set({ exchangeRateCache: { rate, timestamp: currentTime } });
          resolve(rate);
        }
      } catch (error) {
        logger.error(error);
        reject(error);
      }
    });
  });
};
