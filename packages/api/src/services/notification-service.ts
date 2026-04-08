import type { WebSocket } from 'ws';
import type Redis from 'ioredis';
import { logger } from '../utils/logger.js';

/**
 * WebSocket notification service.
 * Manages client connections and broadcasts real-time events.
 *
 * Channels:
 * - claims:feed — all new claims in real-time
 * - vault:stats — vault state updates (solvency, TVP)
 * - agent:{address}:events — events for a specific agent
 * - monitoring:alerts — critical monitoring alerts
 */
export class NotificationService {
  private clients = new Map<string, Set<WebSocket>>();
  private subscriber: Redis;

  constructor(redis: Redis) {
    // Create a dedicated subscriber connection
    this.subscriber = redis.duplicate();
    this.setupRedisSubscription();
  }

  /** Subscribe a WebSocket client to a channel */
  subscribe(channel: string, ws: WebSocket): void {
    if (!this.clients.has(channel)) {
      this.clients.set(channel, new Set());
    }
    this.clients.get(channel)!.add(ws);
    logger.debug({ channel }, 'Client subscribed');
  }

  /** Unsubscribe a WebSocket client from all channels */
  unsubscribe(ws: WebSocket): void {
    for (const [channel, clients] of this.clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        this.clients.delete(channel);
      }
    }
  }

  /** Broadcast a message to all clients on a channel */
  broadcast(channel: string, data: unknown): void {
    const clients = this.clients.get(channel);
    if (!clients || clients.size === 0) return;

    const message = JSON.stringify({
      channel,
      event: 'update',
      data,
      timestamp: Date.now(),
    });

    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  }

  /** Set up Redis pub/sub for cross-process broadcasting */
  private setupRedisSubscription(): void {
    this.subscriber.subscribe('claims:feed', 'vault:stats', 'monitoring:alerts', (err) => {
      if (err) {
        logger.error({ error: err }, 'Failed to subscribe to Redis channels');
      }
    });

    this.subscriber.on('message', (channel, message) => {
      try {
        const data = JSON.parse(message);
        this.broadcast(channel, data);
      } catch (error) {
        logger.error({ error, channel }, 'Failed to parse Redis message');
      }
    });
  }
}
