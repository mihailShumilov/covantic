import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { USDC_DECIMALS } from '@covantic/shared';
import {
  buildFailingInstruction,
  failureStrategies,
  type ExpectedOnChainError,
  type FailureKind,
} from './failures.js';
import type { BehaviorProfile } from './types.js';
import { DEFAULT_PROFILE } from './types.js';

/** Outcome of a single executed action. The shape distinguishes:
 *  - `error`        client / RPC side exception; no tx ever landed.
 *  - `onChainErr`   tx landed and confirmed with a non-null `meta.err`.
 *                   This is the *expected* outcome for a `fail` action.
 *  Both can be absent (`safe`, `large`, `skip`).
 *
 *  `signature` is populated whenever a tx was submitted — regardless of
 *  whether it landed successfully. The activity feed uses it to link to
 *  the explorer.
 */
export interface ActionResult {
  kind: 'safe' | 'large' | 'fail' | 'skip';
  amountUi?: number;
  signature?: string;
  error?: string;
  /** Structured on-chain error for confirmed-failed txs. The shape follows
   *  `TransactionError` from @solana/web3.js (e.g. `{ InstructionError: [0, ...] }`). */
  onChainErr?: unknown;
  /** Which failure strategy produced this result (only set for `kind: 'fail'`). */
  failureKind?: FailureKind;
  /** The strategy's documented expected error class. Lets observers flag a
   *  divergence (e.g. strategy succeeded unexpectedly) without parsing
   *  `onChainErr` free-form. */
  expectedOnChainError?: ExpectedOnChainError;
}

/** Context the action functions need. Kept narrow on purpose so tests
 *  can pass fakes without instantiating real RPC. */
export interface ActionContext {
  connection: Connection;
  agent: Keypair;
  sink: PublicKey;
  /** USDC mint (from env). */
  usdcMint: PublicKey;
  /** Payer for ATA initialization / rent. Defaults to the agent itself,
   *  override if the agent wallet shouldn't cover rent (e.g. low SOL). */
  rentPayer?: Keypair;
}

// ---------------------------------------------------------------------------
// Roll helpers — exported for unit tests.
// ---------------------------------------------------------------------------

export type ActionKind = 'safe' | 'skip' | 'rogue';
export type RogueKind = 'large' | 'fail';

/** Choose the next top-level action from the profile weights. `rng` is
 *  injected so tests can use seeded sequences. */
export function rollAction(profile: BehaviorProfile, rng: () => number = Math.random): ActionKind {
  const total = Math.max(1, profile.safe + profile.skip + profile.rogue);
  const pick = rng() * total;
  if (pick < profile.safe) return 'safe';
  if (pick < profile.safe + profile.skip) return 'skip';
  return 'rogue';
}

/** Choose which rogue variant to run when the top-level roll landed on
 *  'rogue'. `mix` fractions must sum to 1 (we don't re-normalize here —
 *  the profile constructor is where that contract lives). */
export function rollRogue(profile: BehaviorProfile, rng: () => number = Math.random): RogueKind {
  const pick = rng();
  return pick < profile.rogueMix.sendLarge ? 'large' : 'fail';
}

/** Return `ms` to sleep before the next tick, jittered 45–90 s. */
export function rollJitterMs(rng: () => number = Math.random): number {
  const min = 45_000;
  const max = 90_000;
  return Math.floor(min + rng() * (max - min));
}

/** UI amount for a "safe" transfer — small and legitimate-looking,
 *  sub-threshold so the monitor does NOT fire. */
export function rollSafeAmountUi(rng: () => number = Math.random): number {
  const min = 1;
  const max = 50;
  return Math.round((min + rng() * (max - min)) * 100) / 100;
}

/** UI amount for a "large" rogue transfer — above the 1 000 USDC LARGE
 *  threshold so TransactionMonitor flags it. */
export function rollLargeAmountUi(rng: () => number = Math.random): number {
  const min = 2_000;
  const max = 3_000;
  return Math.round(min + rng() * (max - min));
}

// ---------------------------------------------------------------------------
// Action executors. Each returns an ActionResult.
// ---------------------------------------------------------------------------

/** SPL-USDC transfer from agent → sink. Used for both "safe" and "large"
 *  actions; the amount is what distinguishes them. */
export async function executeTransfer(
  ctx: ActionContext,
  amountUi: number,
  kind: 'safe' | 'large',
): Promise<ActionResult> {
  const rentPayer = ctx.rentPayer ?? ctx.agent;
  const source = await getOrCreateAssociatedTokenAccount(
    ctx.connection,
    rentPayer,
    ctx.usdcMint,
    ctx.agent.publicKey,
  );
  const dest = await getOrCreateAssociatedTokenAccount(
    ctx.connection,
    rentPayer,
    ctx.usdcMint,
    ctx.sink,
  );
  const rawAmount = BigInt(Math.round(amountUi * 10 ** USDC_DECIMALS));
  const tx = new Transaction().add(
    createTransferInstruction(source.address, dest.address, ctx.agent.publicKey, rawAmount),
  );
  const signature = await sendAndConfirmTransaction(ctx.connection, tx, [ctx.agent]);
  return { kind, amountUi, signature };
}

/**
 * Produce a deliberately-failing transaction that LANDS on-chain.
 *
 * Flow:
 *   1. Ask the strategy registry for an instruction that's guaranteed to
 *      fail at execution time (not at client-side serialization).
 *   2. Assemble, sign, and send with `skipPreflight: true` so the RPC
 *      does not simulate-and-reject — we *want* the tx to land with a
 *      non-null `meta.err`.
 *   3. Explicitly `confirmTransaction({ signature, blockhash, lastValidBlockHeight })`
 *      under the 'confirmed' commitment. This is the documented safe
 *      pattern for txs that may fail at runtime; `sendAndConfirmTransaction`
 *      throws inconsistently in that case (see solana-web3.js PR #2574).
 *   4. Report the signature *and* the structured on-chain error back to
 *      the caller, so the activity feed / verifier can consume both.
 *
 * Invariants:
 *   - A successful return never has `error` set; either `onChainErr` is
 *     populated (the normal outcome) or `signature` is set without either
 *     (strategy unexpectedly succeeded — logged as a divergence).
 *   - Any thrown exception here comes from the RPC or the keypair and is
 *     surfaced through `error`; the runner treats that as an operational
 *     problem, not a verifier-visible event.
 */
export async function executeFail(
  ctx: ActionContext,
  kind: FailureKind = 'failed_tx',
): Promise<ActionResult> {
  const strategy = failureStrategies[kind];
  if (!strategy) {
    return { kind: 'fail', failureKind: kind, error: `Unknown failure kind: ${kind}` };
  }

  let signature: string | undefined;
  try {
    const ix = buildFailingInstruction(ctx.agent.publicKey, kind);
    const tx = new Transaction().add(ix);
    tx.feePayer = ctx.agent.publicKey;

    const latest = await ctx.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = latest.blockhash;
    tx.lastValidBlockHeight = latest.lastValidBlockHeight;
    tx.sign(ctx.agent);

    // skipPreflight: true — we expect the tx to fail at runtime, so we do
    // not want the RPC to pre-simulate and refuse to forward it. The
    // confirmation below is what distinguishes "landed + failed" (the
    // desired outcome) from "network error" (an operational problem).
    signature = await ctx.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 2,
    });

    const confirmation = await ctx.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      'confirmed',
    );

    // `value.err` is non-null exactly when the tx was confirmed-but-failed.
    // That's our happy path — the AgentError verifier can read it.
    if (confirmation.value.err) {
      return {
        kind: 'fail',
        signature,
        onChainErr: confirmation.value.err,
        failureKind: kind,
        expectedOnChainError: strategy.expectedError,
      };
    }

    // Strategy was expected to fail but the tx succeeded. This is a
    // divergence — surface it so observability can alert on it instead
    // of silently masquerading as a safe tx in the activity feed.
    return {
      kind: 'fail',
      signature,
      failureKind: kind,
      expectedOnChainError: strategy.expectedError,
      error: 'strategy succeeded unexpectedly — tx confirmed without error',
    };
  } catch (err) {
    // RPC errors, signing errors, blockhash fetch failures — all caught
    // here. The tx may or may not have been submitted; if `signature`
    // was set before the throw, include it so we can still investigate.
    return {
      kind: 'fail',
      signature,
      failureKind: kind,
      expectedOnChainError: strategy.expectedError,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Pick + run an action according to the profile. Pure-ish: the caller
 *  supplies the RNG and the context, so tests can replay any branch. */
export async function runOneAction(
  ctx: ActionContext,
  profile: BehaviorProfile = DEFAULT_PROFILE,
  rng: () => number = Math.random,
): Promise<ActionResult> {
  const top = rollAction(profile, rng);
  if (top === 'skip') return { kind: 'skip' };
  if (top === 'safe') {
    const amount = rollSafeAmountUi(rng);
    return executeTransfer(ctx, amount, 'safe');
  }
  const rogue = rollRogue(profile, rng);
  if (rogue === 'large') {
    const amount = rollLargeAmountUi(rng);
    return executeTransfer(ctx, amount, 'large');
  }
  return executeFail(ctx);
}
