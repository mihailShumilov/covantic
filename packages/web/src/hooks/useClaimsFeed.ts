'use client';

import { useEffect, useRef, useState } from 'react';
import type { Claim } from '@covantic/shared';
import { useWsChannel } from './useWsChannel';

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

  useWsChannel<Claim>('claims:feed', (claim) => {
    if (!claim || typeof claim !== 'object' || !('id' in claim)) return;
    setClaims((prev) => {
      const idx = prev.findIndex((c) => c.id === claim.id);
      if (idx === -1) return [claim, ...prev];
      const next = prev.slice();
      next[idx] = claim;
      return next;
    });
  });

  return claims;
}
