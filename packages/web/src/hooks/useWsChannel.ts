'use client';

import { useEffect, useRef } from 'react';
import { WS_URL } from '@/lib/constants';

interface FeedMessage<T = unknown> {
  channel?: string;
  event?: string;
  data?: T;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Subscribe to a server WebSocket channel with exponential-backoff
 * reconnection (with jitter) so a transient outage doesn't produce a
 * thundering herd of reconnects across all tabs.
 *
 * `onMessage` is called with the unwrapped inner payload (the `data`
 * field of the server envelope), or the outer `data` for directly
 * published shapes.
 */
export function useWsChannel<T>(
  channel: string,
  onMessage: (payload: T) => void,
): void {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = INITIAL_BACKOFF_MS;

    function scheduleReconnect() {
      if (cancelled) return;
      const jitter = Math.random() * backoff * 0.25;
      const delay = Math.min(backoff + jitter, MAX_BACKOFF_MS);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      reconnectTimer = setTimeout(connect, delay);
    }

    function connect() {
      if (cancelled) return;
      ws = new WebSocket(`${WS_URL}/ws`);

      ws.onopen = () => {
        backoff = INITIAL_BACKOFF_MS;
        ws?.send(JSON.stringify({ action: 'subscribe', channel }));
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        try {
          const outer = JSON.parse(ev.data) as FeedMessage;
          if (outer.channel !== channel) return;
          const inner = (outer.data as FeedMessage | undefined)?.data ?? outer.data;
          if (inner === undefined || inner === null) return;
          onMessageRef.current(inner as T);
        } catch {
          // Ignore malformed frames.
        }
      };

      ws.onclose = () => {
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [channel]);
}
