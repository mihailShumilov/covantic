import { PublicKey } from '@solana/web3.js';
import { PDA_SEEDS, policyIdToBytes } from '@covantic/shared';
import type { CovanticProgram } from '../../utils/program.js';
import { fetchAnchorAccount } from '../../utils/anchor-reader.js';
import type { SolanaReader } from '../../utils/solana-reader.js';
import type { MandateView } from './types.js';

/**
 * Read the operating envelope a holder declared for their agent.
 *
 * A reader only — there is deliberately no writer here. The mandate is
 * holder-signed, and a backend that could write one would be a backend that
 * could author both the rule and the finding that it was broken. The holder's
 * client is `scripts/declare-agent-mandate.ts`; this process only looks.
 */
export class MandateReader {
  /**
   * @param reader reads the declaration over the endpoint pool — see the note
   * on `GovernanceCheckpointWriter`: a matured, holder-signed declaration
   * cannot be affected by an endpoint's lag, but an outage reading it sends a
   * claim to review.
   */
  constructor(
    private readonly ctx: CovanticProgram,
    private readonly reader: SolanaReader,
  ) {}

  derivePolicyPda(holder: PublicKey, policyId: bigint): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.POLICY), holder.toBuffer(), Buffer.from(policyIdToBytes(policyId))],
      this.ctx.programId,
    )[0];
  }

  deriveConfigPda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.CONFIG)],
      this.ctx.programId,
    )[0];
  }

  deriveMandatePda(policyPda: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.AGENT_MANDATE), policyPda.toBuffer()],
      this.ctx.programId,
    )[0];
  }

  deriveCheckpointPda(policyPda: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.CHECKPOINT), policyPda.toBuffer()],
      this.ctx.programId,
    )[0];
  }

  deriveAgentErrorEvidencePda(policyPda: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.AGENT_ERROR_EVIDENCE), policyPda.toBuffer()],
      this.ctx.programId,
    )[0];
  }

  /**
   * Read the declared envelope in force when a claim was filed.
   *
   * Returns `null` when no declaration exists — a policy older than the
   * mechanism, or a holder who has not declared yet — which the adjudicator
   * turns into review, never a rejection. Throws when the read itself fails,
   * because an outage and an absent declaration must not be collapsed into the
   * same answer.
   *
   * **On `claimSubmittedAt`.** The program checks maturity against
   * `policy.claim_submitted_at`, which `oracle_submit_claim` sets — and that
   * has not happened yet when this runs. So the caller passes the claim row's
   * own creation time, which is necessarily *earlier*. That makes this check
   * strictly stricter than the on-chain one, which is the right direction: a
   * mandate this accepts is one the program will accept, never the reverse.
   *
   * The `prev_*` fallback mirrors the program's `envelope_at`: a refresh that
   * landed after the claim describes the aftermath, and the declaration it
   * replaced is the one that still predates the incident.
   */
  async readMandate(
    holderAddress: string,
    policyId: bigint,
    claimSubmittedAt: number,
  ): Promise<MandateView | null> {
    const policy = this.derivePolicyPda(new PublicKey(holderAddress), policyId);
    const raw = await fetchAnchorAccount<RawMandate>(
      this.ctx,
      this.reader,
      'policyAgentMandate',
      this.deriveMandatePda(policy).toBase58(),
      // Absence here is what sends the claim to review — and, since these
      // reasons are in `UNRESOLVABLE_PARK_REASONS`, what lets any later alert
      // take the policy's only claim slot. Too consequential to rest on one
      // endpoint's word.
      { corroborate: true },
    );
    if (!raw) return null;

    const effectiveAt = num(raw.effectiveAt);
    const prevEffectiveAt = num(raw.prevEffectiveAt);
    const current = effectiveAt > 0 && effectiveAt <= claimSubmittedAt;

    const maxSingleOutflowRaw = current
      ? num(raw.maxSingleOutflow)
      : num(raw.prevMaxSingleOutflow);
    const minRetainedBalanceRaw = current
      ? num(raw.minRetainedBalance)
      : num(raw.prevMinRetainedBalance);
    const inForceAt = current ? effectiveAt : prevEffectiveAt;

    const counterpartyCount = Number(raw.counterpartyCount ?? 0);
    const programCount = Number(raw.programCount ?? 0);
    const zero = PublicKey.default.toBase58();

    return {
      maxSingleOutflowRaw,
      // Window and allowlists have no `prev_*` on chain — they are off-chain
      // dimensions, and carrying a partial history for them would imply a
      // precision the account does not have.
      maxWindowOutflowRaw: num(raw.maxWindowOutflow),
      windowSeconds: num(raw.windowSeconds),
      minRetainedBalanceRaw,
      allowedCounterparties: (raw.allowedCounterparties ?? [])
        .slice(0, counterpartyCount)
        .map((k) => k.toBase58())
        .filter((k) => k !== zero),
      allowedPrograms: (raw.allowedPrograms ?? [])
        .slice(0, programCount)
        .map((k) => k.toBase58())
        .filter((k) => k !== zero),
      manifestHash: Buffer.from(raw.manifestHash ?? []).toString('hex'),
      declaredAt: num(raw.declaredAt),
      effectiveAt: inForceAt,
      // The same comparison the program performs. Computed here rather than
      // read as a flag so a stale mirror cannot claim maturity the chain would
      // refuse.
      maturedBeforeClaim: inForceAt > 0 && inForceAt <= claimSubmittedAt,
    };
  }

  private accounts(): Record<
    string,
    { fetch: (a: PublicKey) => Promise<unknown>; fetchNullable: (a: PublicKey) => Promise<unknown> }
  > {
    return this.ctx.program.account as unknown as Record<
      string,
      {
        fetch: (a: PublicKey) => Promise<unknown>;
        fetchNullable: (a: PublicKey) => Promise<unknown>;
      }
    >;
  }
}

function num(value: { toString(): string } | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

/** The shape Anchor hands back for a `PolicyAgentMandate` account. */
interface RawMandate {
  maxSingleOutflow: { toString(): string };
  maxWindowOutflow: { toString(): string };
  windowSeconds: { toString(): string };
  minRetainedBalance: { toString(): string };
  allowedCounterparties: PublicKey[];
  counterpartyCount: number;
  allowedPrograms: PublicKey[];
  programCount: number;
  manifestHash: number[];
  declaredAt: { toString(): string };
  effectiveAt: { toString(): string };
  prevMaxSingleOutflow: { toString(): string };
  prevMinRetainedBalance: { toString(): string };
  prevEffectiveAt: { toString(): string };
}
