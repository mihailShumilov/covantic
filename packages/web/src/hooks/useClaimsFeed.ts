'use client';

import { useEffect, useRef, useState } from 'react';
import { WS_URL } from '@/lib/constants';
import type { Claim } from '@covantic/shared';

interface FeedMessage {
  channel?: string;
  event?: string;
  data?: unknown;
}

/**
 * Subscribe to the `claims:feed` WebSocket channel and merge live claim
 * updates into a list seeded by the initial HTTP fetch. Keyed by claim id;
 * newest claims land at the top, updates to an existing claim replace the
 * row in place.
 */
export function useClaimsFeed(initial: Claim[]): Claim[] {
  const [claims, setClaims] = useState<Claim[]>(initial);
  const initialRef = useRef(initial);

  // Re-seed if parent re-fetches (e.g. tab focus)
  useEffect(() => {
    if (initial !== initialRef.current) {
      setClaims(initial);
      initialRef.current = initial;
    }
  }, [initial]);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      ws = new WebSocket(`${WS_URL}/ws`);

      ws.onopen = () => {
        ws?.send(JSON.stringify({ action: 'subscribe', channel: 'claims:feed' }));
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        try {
          const outer = JSON.parse(ev.data) as FeedMessage;
          if (outer.channel !== 'claims:feed') return;
          // NotificationService wraps incoming messages; the claim row sits in
          // data.data because the keeper publishes {channel, event, data, ...}
          // and NotificationService re-wraps. Fall back to outer.data for
          // directly-published shapes.
          const inner = (outer.data as FeedMessage | undefined)?.data ?? outer.data;
          const claim = inner as Claim | undefined;
          if (!claim || typeof claim !== 'object' || !('id' in claim)) return;

          setClaims((prev) => {
            const idx = prev.findIndex((c) => c.id === claim.id);
            if (idx === -1) return [claim, ...prev];
            const next = prev.slice();
            next[idx] = claim;
            return next;
          });
        } catch {
          // Ignore malformed frames; the server's own validation already
          // dropped the bad ones.
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, 2000);
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
  }, []);

  return claims;
}
