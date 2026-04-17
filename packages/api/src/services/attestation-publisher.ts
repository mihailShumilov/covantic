import anchorPkg from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';

const { BN } = anchorPkg;
import { ATTESTATION_MAX_VALIDITY_SECONDS, PDA_SEEDS, RiskTier } from '@covantic/shared';
import { createCovanticProgram, type CovanticProgram } from '../utils/program.js';
import type { AppConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';

/** Refresh the on-chain attestation when fewer than this many seconds remain. */
const REFRESH_THRESHOLD_SECONDS = 300;

/** Default validity window for newly minted attestations. */
const DEFAULT_VALIDITY_SECONDS = ATTESTATION_MAX_VALIDITY_SECONDS;

export interface AttestationInfo {
  attestationPda: string;
  tier: RiskTier;
  expiresAt: Date;
  signature?: string;
}

interface OnChainAttestation {
  agent: PublicKey;
  tier: number;
  issuedAt: bigint;
  expiresAt: bigint;
}

/**
 * Publishes oracle-signed risk attestations on-chain. One instance is shared
 * across request handlers; the underlying Anchor program + oracle keypair is
 * created lazily on first use so missing config at boot doesn't break the
 * rest of the API.
 */
export class AttestationPublisher {
  private ctx: CovanticProgram | null = null;

  constructor(private readonly config: AppConfig) {}

  /** Lazily create (and cache) the oracle-signing program context. */
  private getCtx(): CovanticProgram {
    if (!this.ctx) {
      this.ctx = createCovanticProgram(this.config, { withOracle: true });
    }
    return this.ctx;
  }

  /** Derive the RiskAttestation PDA for a given agent. */
  deriveAttestationPda(agent: PublicKey): PublicKey {
    const ctx = this.getCtx();
    return PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.ATTESTATION), agent.toBuffer()],
      ctx.programId,
    )[0];
  }

  /**
   * Ensure the on-chain attestation for `agent` is fresh and matches `tier`.
   *
   * Fetches the current PDA and only sends a transaction if it's missing,
   * tier has changed, or it expires within `REFRESH_THRESHOLD_SECONDS`.
   * Returns the PDA address + expiry either way.
   *
   * Callers must have already rejected EXTREME — this method assumes
   * `tier` is one of LOW/MEDIUM/HIGH.
   */
  async ensureFresh(agentAddress: string, tier: RiskTier): Promise<AttestationInfo> {
    if (tier === RiskTier.EXTREME) {
      throw new Error('Refusing to publish attestation for EXTREME tier');
    }

    const ctx = this.getCtx();
    const agent = new PublicKey(agentAddress);
    const pda = this.deriveAttestationPda(agent);
    const nowSec = Math.floor(Date.now() / 1000);

    const existing = await this.fetchExisting(ctx, pda);
    if (
      existing &&
      existing.tier === tier &&
      Number(existing.expiresAt) > nowSec + REFRESH_THRESHOLD_SECONDS
    ) {
      return {
        attestationPda: pda.toBase58(),
        tier,
        expiresAt: new Date(Number(existing.expiresAt) * 1000),
      };
    }

    const validFor = DEFAULT_VALIDITY_SECONDS;
    const signature = await (ctx.program.methods as any)
      .upsertAttestation(agent, tier, new BN(validFor))
      .accounts({
        oracle: ctx.oracleKeypair!.publicKey,
        // `config` + `attestation` are resolved automatically from IDL seeds;
        // we only pass what Anchor cannot derive.
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    logger.info(
      { agent: agentAddress, tier, pda: pda.toBase58(), signature },
      'Published risk attestation on-chain',
    );

    return {
      attestationPda: pda.toBase58(),
      tier,
      expiresAt: new Date((nowSec + validFor) * 1000),
      signature,
    };
  }

  private async fetchExisting(
    ctx: CovanticProgram,
    pda: PublicKey,
  ): Promise<OnChainAttestation | null> {
    const accountNamespace = (ctx.program.account as Record<string, any>).riskAttestation;
    if (!accountNamespace) {
      throw new Error('IDL is missing riskAttestation account — rebuild the anchor program');
    }
    try {
      const raw = await accountNamespace.fetch(pda);
      return {
        agent: raw.agent as PublicKey,
        tier: Number(raw.tier),
        issuedAt: BigInt(raw.issuedAt.toString()),
        expiresAt: BigInt(raw.expiresAt.toString()),
      };
    } catch (err) {
      if (err instanceof Error && /Account does not exist/i.test(err.message)) {
        return null;
      }
      throw err;
    }
  }
}
