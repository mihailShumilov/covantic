import type { PublicKey } from '@solana/web3.js';
import type { CovanticProgram } from './program.js';
import { fetchAnchorAccount } from './anchor-reader.js';
import type { SolanaReader } from './solana-reader.js';

/** The fields of `ProtocolConfig` the workers derive accounts from. */
export interface ProtocolConfigView {
  usdcMint: PublicKey;
}

const cache = new Map<string, ProtocolConfigView>();

/**
 * Read the protocol config, once per process.
 *
 * Every checkpoint write and every proof poster derived the covered token
 * account from `config.usdc_mint`, and each of them read the config account
 * to do it — two reads per insured agent per sweep tick, for a value that is
 * written once at `initialize` and never changes. On an endpoint pool close
 * to its quota those reads were a quarter of the sweep. The first successful
 * read is kept for the life of the process; a read that fails is not cached,
 * so an outage does not pin a missing answer.
 */
export async function readProtocolConfig(
  ctx: CovanticProgram,
  reader: SolanaReader,
  address: string,
): Promise<ProtocolConfigView | null> {
  const cached = cache.get(address);
  if (cached) return cached;
  const cfg = await fetchAnchorAccount<ProtocolConfigView>(ctx, reader, 'protocolConfig', address);
  if (cfg) cache.set(address, { usdcMint: cfg.usdcMint });
  return cfg ? { usdcMint: cfg.usdcMint } : null;
}

/** Test seam: forget what was read. */
export function resetProtocolConfigCache(): void {
  cache.clear();
}
