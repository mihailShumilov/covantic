import { PublicKey } from '@solana/web3.js';
import type { AppConfig } from '../config/env.js';
import { createCovanticProgram, type CovanticProgram } from './program.js';
import { logger } from './logger.js';

/**
 * Lazy, process-wide read-only handle to the Anchor program.
 *
 * Routes that need to fetch on-chain state (e.g. /policies/:id/why-active)
 * go through {@link getPolicyReader} so we don't pay IDL-load cost at boot
 * and don't break API startup if the IDL isn't built yet.
 */

let cached: CovanticProgram | null = null;
let lastError: Error | null = null;

function getReader(config: AppConfig): CovanticProgram | null {
  if (cached) return cached;
  try {
    cached = createCovanticProgram(config, { withOracle: false });
    lastError = null;
    return cached;
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err));
    logger.warn({ err }, 'policy-reader: failed to initialise Anchor program (IDL missing?)');
    return null;
  }
}

export interface OnChainPolicy {
  policyId: number;
  holder: string;
  agentAddress: string;
  state: number;
  triggerType: number;
  startTimeSec: number;
  expiryTimeSec: number;
  claimSubmittedAtSec: number;
  coverageAmount: number;
  premiumPaid: number;
  riskTier: number;
  payoutAmount: number;
}

function bnToNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const maybe = v as { toNumber?: () => number };
  if (typeof maybe.toNumber === 'function') return maybe.toNumber();
  return Number(v);
}

export type FetchFailureReason =
  | 'not-found'
  | 'owner-mismatch'
  | 'decode-error'
  | 'rpc-error';

export interface FetchOnChainPolicyResult {
  policy: OnChainPolicy | null;
  reason: FetchFailureReason | null;
  detail: string | null;
}

/**
 * Fetch the on-chain InsurancePolicy account at `pdaAddress`.
 *
 * Always resolves — never throws. When the fetch can't produce a decoded
 * policy the caller gets a structured {@link FetchFailureReason} so
 * `/why-active` (and other diagnostics) can name the exact failure mode:
 *
 * - `not-found`: PDA doesn't exist (closed, wrong PDA, or never created).
 * - `owner-mismatch`: PDA exists but is owned by a different program —
 *   classic symptom of a stale DB row after a program redeploy.
 * - `decode-error`: layout mismatch (account size / field drift). Usually
 *   an orphan from a previous program version.
 * - `rpc-error`: the RPC call itself failed; retry once the network is up.
 */
export async function fetchOnChainPolicy(
  config: AppConfig,
  pdaAddress: string,
): Promise<FetchOnChainPolicyResult> {
  const reader = getReader(config);
  if (!reader) {
    return { policy: null, reason: null, detail: null };
  }

  const pda = new PublicKey(pdaAddress);

  // Step 1: raw getAccountInfo so we can distinguish not-found /
  // owner-mismatch from a decode failure. Going through Anchor's
  // fetchNullable alone collapses all three into one opaque throw.
  let accountInfo: Awaited<ReturnType<typeof reader.connection.getAccountInfo>>;
  try {
    accountInfo = await reader.connection.getAccountInfo(pda, 'confirmed');
  } catch (err) {
    return {
      policy: null,
      reason: 'rpc-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!accountInfo) {
    return { policy: null, reason: 'not-found', detail: null };
  }
  if (!accountInfo.owner.equals(reader.programId)) {
    return {
      policy: null,
      reason: 'owner-mismatch',
      detail: `Account owner ${accountInfo.owner.toBase58()} != program ${reader.programId.toBase58()} (likely orphan from an earlier program deployment)`,
    };
  }

  // Step 2: deserialize. Any failure here means layout drift against the
  // loaded IDL — treat it as decode-error rather than letting the raw
  // buffer offset panic bubble up to the caller.
  const accountNs = (reader.program.account as unknown as {
    insurancePolicy: {
      coder: { accounts: { decode: (name: string, data: Buffer) => Record<string, unknown> } };
    };
  }).insurancePolicy;
  let account: Record<string, unknown>;
  try {
    account = accountNs.coder.accounts.decode('insurancePolicy', accountInfo.data);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(
      { pdaAddress, dataLen: accountInfo.data.length, err: detail },
      'policy-reader: decode failed (layout drift or orphan account)',
    );
    return { policy: null, reason: 'decode-error', detail };
  }

  return {
    policy: {
      policyId: bnToNumber(account.policyId),
      holder: (account.holder as PublicKey).toBase58(),
      agentAddress: (account.agentAddress as PublicKey).toBase58(),
      state: account.state as number,
      triggerType: (account.triggerType as number) ?? 0,
      startTimeSec: bnToNumber(account.startTime),
      expiryTimeSec: bnToNumber(account.expiryTime),
      claimSubmittedAtSec: bnToNumber(account.claimSubmittedAt),
      coverageAmount: bnToNumber(account.coverageAmount),
      premiumPaid: bnToNumber(account.premiumPaid),
      riskTier: account.riskTier as number,
      payoutAmount: bnToNumber(account.payoutAmount),
    },
    reason: null,
    detail: null,
  };
}

export function getPolicyReaderStatus(config: AppConfig): {
  available: boolean;
  lastError: string | null;
} {
  const r = getReader(config);
  return { available: !!r, lastError: lastError?.message ?? null };
}
