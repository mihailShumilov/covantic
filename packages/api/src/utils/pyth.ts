import { logger } from './logger.js';

/** Price data from Pyth */
export interface PythPrice {
  price: number;
  confidence: number;
  timestamp: number;
}

/** Pyth Hermes REST endpoint (free, no API key required) */
const PYTH_HERMES_URL = 'https://hermes.pyth.network';

/**
 * Pyth price feed IDs (hex, without 0x prefix).
 * See: https://pyth.network/developers/price-feed-ids
 */
const FEED_IDS: Record<string, string> = {
  'SOL/USD': 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  'BTC/USD': 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH/USD': 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  'USDC/USD': 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
};

interface HermesPriceEntry {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

interface HermesResponse {
  parsed?: Array<{ price?: HermesPriceEntry }>;
}

/** Pyth price feed helper backed by the Hermes HTTP API. */
export class PythClient {
  /** Get current price for a feed (e.g. 'SOL/USD') */
  async getPrice(feedId: string): Promise<PythPrice | null> {
    try {
      const pythFeedId = FEED_IDS[feedId];
      if (!pythFeedId) {
        logger.warn({ feedId }, 'Unknown Pyth feed ID');
        return null;
      }

      const url = `${PYTH_HERMES_URL}/v2/updates/price/latest?ids[]=${pythFeedId}&parsed=true`;
      const response = await fetch(url);
      if (!response.ok) {
        logger.error({ feedId, status: response.status }, 'Pyth Hermes API error');
        return null;
      }

      const data = (await response.json()) as HermesResponse;
      const priceData = data.parsed?.[0]?.price;
      if (!priceData) {
        logger.warn({ feedId }, 'No price data in Pyth response');
        return null;
      }

      const price = Number(priceData.price) * Math.pow(10, priceData.expo);
      const confidence = Number(priceData.conf) * Math.pow(10, priceData.expo);

      return {
        price,
        confidence,
        timestamp: priceData.publish_time,
      };
    } catch (error) {
      logger.error({ error, feedId }, 'Failed to fetch Pyth price');
      return null;
    }
  }

  /**
   * Return the current spot price for a feed. Hermes does not serve
   * historical ticks, so there is no real TWAP available — callers that
   * need one should query the Pyth Benchmarks API directly.
   */
  async getSpotPrice(feedId: string): Promise<number | null> {
    const price = await this.getPrice(feedId);
    return price?.price ?? null;
  }
}
