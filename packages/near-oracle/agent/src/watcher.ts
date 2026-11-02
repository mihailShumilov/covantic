import { PublicKey } from '@solana/web3.js';
import { log } from './log.js';
import { processTrigger } from './pipeline.js';
import type { AgentDeps } from './pipeline.js';

const SIGNATURE_PAGE = 25;

interface SignatureInfo {
  signature: string;
  err: unknown;
}

/** Newest signature already settled for each watched policy. */
export type Cursors = Map<string, string | undefined>;

/**
 * Reads the covered agent's new transactions, oldest first. The cursor stops
 * at a retryable result so that trigger is judged again on the next poll.
 */
export async function pollPolicy(
  deps: AgentDeps,
  policyAddress: PublicKey,
  cursors: Cursors,
): Promise<void> {
  const key = policyAddress.toBase58();
  const policy = await deps.program.readPolicy(policyAddress);
  const options: { limit: number; until?: string } = { limit: SIGNATURE_PAGE };
  const until = cursors.get(key);
  if (until) options.until = until;

  const page = await deps.rpc.call<SignatureInfo[]>('getSignaturesForAddress', [
    policy.agent,
    options,
  ]);
  for (const { signature, err } of [...page].reverse()) {
    if (!err) {
      const result = await processTrigger(deps, policyAddress, signature);
      if (result.verdict === 'NO_PAY' && result.retryable) return;
    }
    cursors.set(key, signature);
  }
}

export async function watch(deps: AgentDeps, policies: PublicKey[]): Promise<never> {
  const cursors: Cursors = new Map();
  log(`watching ${policies.length} policies`);
  for (;;) {
    for (const policy of policies) {
      try {
        await pollPolicy(deps, policy, cursors);
      } catch (error) {
        log(`poll failed for ${policy.toBase58()}: ${String(error)}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, deps.config.pollIntervalMs));
  }
}
