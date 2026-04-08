import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';

/** Price data from Pyth */
export interface PythPrice {
  price: number;
  confidence: number;
  timestamp: number;
}

/** Pyth price feed helper */
export class PythClient {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /** Get current price for a feed (e.g. SOL/USD) */
  async getPrice(feedId: string): Promise<PythPrice | null> {
    try {
      // In production, use @pythnetwork/pyth-solana-receiver
      // For now, return mock data for development
      logger.debug({ feedId }, 'Fetching Pyth price');
      return {
        price: 150.0, // Mock SOL/USD price
        confidence: 0.05,
        timestamp: Math.floor(Date.now() / 1000),
      };
    } catch (error) {
      logger.error({ error, feedId }, 'Failed to fetch Pyth price');
      return null;
    }
  }

  /** Calculate TWAP over a time window */
  async getTwap(feedId: string, _windowSeconds: number): Promise<number | null> {
    try {
      // In production, query historical price data
      const price = await this.getPrice(feedId);
      return price?.price ?? null;
    } catch (error) {
      logger.error({ error, feedId }, 'Failed to calculate TWAP');
      return null;
    }
  }
}
