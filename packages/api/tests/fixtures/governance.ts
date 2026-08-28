import type { ParsedIx } from '../../src/services/exploit/raw-tx.js';
import { BPF_LOADER_UPGRADEABLE } from '../../src/services/governance/authority.js';

export * from './exploit.js';

/** A second wallet the holder also controls — the Sybil case the chain
 *  cannot rule out and the corpus therefore has to state explicitly. */
export const HOLDER_SECOND_WALLET = 'GgqfnGgQK6JgNCbtHqQ2Q6vTJqTPCkAWhpNo8FvBqiWV';
export const AGENT_PROGRAM_DATA = 'FZbgFcC1L9xLpQzXpQyXnTGkKk9y1Y7YZk1CzMhY6q9M';
export const SQUADS_V4 = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';

/** An upgradeable-loader instruction as the RPC's jsonParsed encoding reports it. */
export function loaderIx(
  type: string,
  info: Record<string, unknown>,
  opts: { inner?: boolean; outerIndex?: number } = {},
): ParsedIx {
  return {
    programId: BPF_LOADER_UPGRADEABLE,
    type,
    info,
    accounts: [],
    inner: opts.inner ?? false,
    outerIndex: opts.outerIndex ?? 0,
  };
}
