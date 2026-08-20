import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PDA_SEEDS, policyIdToBytes } from '@covantic/shared';
import { logger } from '../../utils/logger.js';
import type { CovanticProgram } from '../../utils/program.js';
import type { GovernanceBaselineView } from './types.js';

/**
 * Write and read the on-chain facts a governance payout is bounded by.
 *
 * The instruction this drives is permissionless, and that is load-bearing
 * rather than convenient: a record only the oracle could write would put the
 * oracle back in charge of the very facts the bound is supposed to constrain.
 * This client happens to be the oracle process because that is what is
 * already running, not because it has to be — anyone can keep a policy's
 * authority checkpoint fresh, and a policyholder who does not trust the
 * operator should.
 *
 * Nothing here chooses what gets recorded. The covered account's address is
 * derived by the program from the policy's own agent address, so this code
 * cannot point the reading anywhere else even if it wanted to.
 */
export class AuthorityCheckpointWriter {
  constructor(private readonly ctx: CovanticProgram) {}

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

  deriveAuthorityCheckpointPda(policyPda: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.AUTHORITY_CHECKPOINT), policyPda.toBuffer()],
      this.ctx.programId,
    )[0];
  }

  deriveBaselinePda(policyPda: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.GOVERNANCE_BASELINE), policyPda.toBuffer()],
      this.ctx.programId,
    )[0];
  }

  deriveGovernanceEvidencePda(policyPda: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.GOVERNANCE_EVIDENCE), policyPda.toBuffer()],
      this.ctx.programId,
    )[0];
  }

  /**
   * Send one `checkpoint_authority` transaction.
   *
   * Returns the signature, or null when the write could not land. A failed
   * checkpoint is not an emergency — the previous one still stands and the
   * next tick tries again — but it does narrow the window in which a claim
   * can be proven, so it is logged rather than swallowed.
   */
  async checkpoint(
    holderAddress: string,
    policyId: bigint,
    agentAddress: string,
  ): Promise<string | null> {
    const signer = this.ctx.oracleKeypair;
    if (!signer) throw new Error('AuthorityCheckpointWriter requires a signing keypair');

    const holder = new PublicKey(holderAddress);
    const config = this.deriveConfigPda();
    const policy = this.derivePolicyPda(holder, policyId);

    try {
      const cfg = (await this.accounts().protocolConfig!.fetch(config)) as {
        usdcMint: PublicKey;
      };
      const coveredTokenAccount = getAssociatedTokenAddressSync(
        cfg.usdcMint,
        new PublicKey(agentAddress),
      );

      const methods = this.ctx.program.methods as unknown as Record<
        string,
        () => { accounts: (a: Record<string, PublicKey>) => { rpc: () => Promise<string> } }
      >;

      return await methods
        .checkpointAuthority!()
        .accounts({
          cranker: signer.publicKey,
          config,
          policy,
          coveredTokenAccount,
          usdcMint: cfg.usdcMint,
          checkpoint: this.deriveAuthorityCheckpointPda(policy),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : err,
          policyId: policyId.toString(),
          agentAddress,
        },
        'authority checkpoint: on-chain write failed; the previous reading still stands',
      );
      return null;
    }
  }

  /**
   * Read the holder's declared authority set.
   *
   * Returns `null` when no declaration exists — a policy older than the
   * mechanism — which the adjudicator turns into review, never a rejection.
   * Throws when the read itself fails, because an outage and an absent
   * declaration must not be collapsed into the same answer.
   */
  async readBaseline(
    holderAddress: string,
    policyId: bigint,
    claimSubmittedAt: number,
  ): Promise<GovernanceBaselineView | null> {
    const policy = this.derivePolicyPda(new PublicKey(holderAddress), policyId);
    const raw = (await this.accounts().governanceBaseline!.fetchNullable(
      this.deriveBaselinePda(policy),
    )) as RawBaseline | null;
    if (!raw) return null;

    const extraCount = Number(raw.extraAuthorityCount ?? 0);
    const extras = (raw.extraAuthorities ?? [])
      .slice(0, extraCount)
      .map((k) => k.toBase58())
      .filter((k) => k !== PublicKey.default.toBase58());

    const named = [
      raw.tokenOwner,
      raw.expectedDelegate,
      raw.expectedCloseAuthority,
      raw.programUpgradeAuthority,
      raw.controller,
    ]
      .filter((k): k is PublicKey => k !== null && k !== undefined)
      .map((k) => k.toBase58());

    const effectiveAt = Number(raw.effectiveAt?.toString() ?? 0);

    return {
      authorities: [...new Set([...named, ...extras])].sort(),
      tokenOwner: raw.tokenOwner.toBase58(),
      expectedDelegate: raw.expectedDelegate?.toBase58() ?? null,
      expectedCloseAuthority: raw.expectedCloseAuthority?.toBase58() ?? null,
      programUpgradeAuthority: raw.programUpgradeAuthority?.toBase58() ?? null,
      controller: raw.controller?.toBase58() ?? null,
      controllerMinThreshold: Number(raw.controllerMinThreshold ?? 0),
      manifestHash: Buffer.from(raw.manifestHash ?? []).toString('hex'),
      effectiveAt,
      // The same comparison the program performs. Computed here rather than
      // read as a flag so a stale mirror cannot claim maturity the chain
      // would refuse.
      maturedBeforeClaim: effectiveAt > 0 && effectiveAt <= claimSubmittedAt,
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

/** The shape Anchor hands back for a `GovernanceBaseline` account. */
interface RawBaseline {
  tokenOwner: PublicKey;
  expectedDelegate: PublicKey | null;
  expectedCloseAuthority: PublicKey | null;
  programUpgradeAuthority: PublicKey | null;
  controller: PublicKey | null;
  controllerMinThreshold: number;
  extraAuthorities: PublicKey[];
  extraAuthorityCount: number;
  manifestHash: number[];
  effectiveAt: { toString(): string };
}
