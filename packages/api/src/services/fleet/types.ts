/**
 * Types describing the agent fleet: a set of autonomous on-chain agents
 * the demo runs continuously so visitors see real activity flowing through
 * the insurance pipeline without clicking anything.
 */

/** Behavior profile attached to each fleet agent. Determines the weights
 *  the runner applies when rolling the next action. */
export interface BehaviorProfile {
  /** Relative weights. Not required to sum to anything — the runner
   *  normalizes. */
  safe: number;
  skip: number;
  rogue: number;
  /** Fractions of rogue actions. Must sum to 1. */
  rogueMix: {
    sendLarge: number;
    failTx: number;
  };
}

/** Default profile for a typical agent — mostly well-behaved with occasional
 *  misbehavior. Tunable per-agent by overriding in the manifest. */
export const DEFAULT_PROFILE: BehaviorProfile = {
  safe: 80,
  skip: 15,
  rogue: 5,
  rogueMix: { sendLarge: 0.6, failTx: 0.4 },
};

/** Single entry in `keys/fleet.json`. */
export interface FleetAgent {
  /** Human-readable identifier. Used for keypair filename
   *  (`keys/agents/<name>.json`) and log tags. */
  name: string;
  /** Agent's Solana pubkey (base58). */
  pubkey: string;
  /** Holder pubkey that owns the policy for this agent. */
  holderPubkey: string;
  /** On-chain policy id (u64) purchased against this agent. */
  policyId: number;
  /** Coverage amount in raw USDC lamports (6 decimals). */
  coverageAmountRaw: number;
  /** Risk tier at the time the policy was bought (0=LOW … 3=EXTREME). */
  riskTier: number;
  /** Seconds of policy coverage at purchase. */
  durationSeconds: number;
  /** ISO8601 timestamp of policy creation. */
  createdAt: string;
  /** Behavior profile. Optional — runner uses DEFAULT_PROFILE when absent. */
  profile?: BehaviorProfile;
}

/** Top-level manifest. Persisted at `keys/fleet.json`. */
export interface FleetManifest {
  version: 1;
  /** Holder keypair path (under `keys/`). Shared across all fleet agents. */
  holderKeypairPath: string;
  /** List of agents. Ordered by creation; never modified in place. */
  agents: FleetAgent[];
  /** ISO8601 of the last bootstrap run. */
  updatedAt: string;
}

/** Single activity row pushed to Redis list `covantic:fleet:activity`.
 *
 *  Failure rows carry two orthogonal error fields:
 *    - `error`       runner-side exception; no tx ever landed on-chain.
 *    - `onChainErr`  structured `meta.err` from a confirmed-failed tx.
 *                    Serialized JSON of @solana/web3.js' TransactionError.
 *  A row with only `onChainErr` is the *expected* outcome of a `fail`
 *  action. A row with `error` signals an operational problem (RPC down,
 *  signing bug, etc.) and should be alerted on in production. */
export interface FleetActivityEntry {
  timestamp: number;
  agentName: string;
  agentPubkey: string;
  kind: 'safe' | 'large' | 'fail' | 'skip' | 'error';
  amountUi?: number;
  signature?: string;
  error?: string;
  /** Structured on-chain error (present only for `kind: 'fail'` when the
   *  tx confirmed with a non-null `meta.err`). */
  onChainErr?: unknown;
  /** Which failure strategy produced the tx (`failed_tx`, future kinds). */
  failureKind?: string;
}

export const FLEET_ACTIVITY_KEY = 'covantic:fleet:activity';
export const FLEET_ACTIVITY_CAP = 500;
