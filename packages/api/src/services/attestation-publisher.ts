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

/**
 * Is this the failure of reading an account written under the old layout?
 *
 * Matched on the Anchor error rather than on a size, because the size is not
 * in the message and the caller has not read the account — this is the first
 * time anything touched it.
 */
export function isUndersizedAccount(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message}` : String(err);
  return (
    // The program's own answer, when the account reaches it.
    /AccountDidNotDeserialize|failed to deserialize|Account discriminator did not match|range end index/i.test(
      text,
    ) ||
    // The client decoder's, when it does not. This is the one that actually
    // fires: Anchor reads the account before sending anything, and a struct
    // six bytes longer than the buffer throws
    // `The value of "offset" is out of range. It must be >= 0 and <= 83.
    // Received 89` from Node's DataView — a message with no Solana in it at
    // all. Matching only the Rust wording meant the guard never ran, and the
    // read threw before the send it was guarding could be attempted.
    /offset["']? is out of range|out of range.*Received \d+/i.test(text)
  );
}

interface OnChainAttestation {
  agent: PublicKey;
  tier: number;
  issuedAt: bigint;
  expiresAt: bigint;
  /** The envelope this attestation's premium was quoted for, hex. */
  mandateHash: string;
  envelopeFlatPremium: number;
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
  /**
   * @param mandateHash the envelope this quote prices, as
   * `agentMandateCommitment` computes it. `create_policy` recomputes it from
   * the arguments it is handed and refuses a mismatch, so an attestation
   * published for a generous envelope cannot be spent on a narrow one.
   * @param envelopeFlatPremium what that envelope costs, flat, in base units.
   */
  async ensureFresh(
    agentAddress: string,
    tier: RiskTier,
    mandateHash: Uint8Array,
    envelopeFlatPremium: number,
  ): Promise<AttestationInfo> {
    if (tier === RiskTier.EXTREME) {
      throw new Error('Refusing to publish attestation for EXTREME tier');
    }

    const ctx = this.getCtx();
    const agent = new PublicKey(agentAddress);
    const pda = this.deriveAttestationPda(agent);
    const nowSec = Math.floor(Date.now() / 1000);

    const existingOrStale = await this.fetchExisting(ctx, pda);
    // Grow it before anything else. The write below would fail on the same
    // account, and the reuse check underneath cannot compare fields it could
    // not read.
    if (existingOrStale === 'unreadable') {
      logger.warn(
        { agent: agentAddress, pda: pda.toBase58() },
        'attestation predates the current layout — growing it before republishing',
      );
      await (ctx.program.methods as any)
        .migrateAttestation()
        .accounts({
          payer: ctx.oracleKeypair!.publicKey,
          agent,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    const existing = existingOrStale === 'unreadable' ? null : existingOrStale;
    // Reused only when it prices *this* envelope.
    //
    // The tier used to be the whole identity of an attestation, and it no
    // longer is: the same agent at the same tier can be quoted for two
    // different deductibles, and `create_policy` compares the commitment. A
    // stale attestation returned here would be one the purchase then rejects,
    // with nothing on the screen explaining why.
    const wantedHash = Buffer.from(mandateHash).toString('hex');
    if (
      existing &&
      existing.tier === tier &&
      existing.mandateHash === wantedHash &&
      existing.envelopeFlatPremium === envelopeFlatPremium &&
      Number(existing.expiresAt) > nowSec + REFRESH_THRESHOLD_SECONDS
    ) {
      return {
        attestationPda: pda.toBase58(),
        tier,
        expiresAt: new Date(Number(existing.expiresAt) * 1000),
      };
    }

    const validFor = DEFAULT_VALIDITY_SECONDS;
    const send = () =>
      (ctx.program.methods as any)
        .upsertAttestation(
          agent,
          tier,
          new BN(validFor),
          Array.from(mandateHash),
          new BN(envelopeFlatPremium),
        )
        .accounts({
          oracle: ctx.oracleKeypair!.publicKey,
          // `config` + `attestation` are resolved automatically from IDL seeds;
          // we only pass what Anchor cannot derive.
          systemProgram: SystemProgram.programId,
        })
        .rpc();

    let signature: string;
    try {
      signature = await send();
    } catch (err) {
      // An attestation written before the envelope was priced is 34 bytes too
      // short, and `init_if_needed` deserialises an existing account before any
      // constraint could resize it. Every agent quoted under the old program
      // has one, so without this the upgrade would break quoting for exactly
      // the agents somebody already cared about — and the error would say
      // "AccountDidNotDeserialize", which names the symptom and not the cause.
      //
      // Growing it is permissionless and leaves zeros, which `create_policy`
      // refuses; the write that follows fills them in.
      if (!isUndersizedAccount(err)) throw err;
      logger.warn(
        { agent: agentAddress, pda: pda.toBase58() },
        'attestation predates envelope pricing — growing it before republishing',
      );
      await (ctx.program.methods as any)
        .migrateAttestation()
        .accounts({
          payer: ctx.oracleKeypair!.publicKey,
          agent,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      signature = await send();
    }

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
  ): Promise<OnChainAttestation | null | 'unreadable'> {
    // On the provider's connection rather than the read pool: the answer
    // decides whether the next instruction initialises this PDA or updates it,
    // and it is usually read moments after this same process wrote it. An
    // endpoint a slot or two behind would pick the wrong instruction.
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
        mandateHash: Buffer.from(raw.mandateHash ?? []).toString('hex'),
        envelopeFlatPremium: Number(raw.envelopeFlatPremium ?? 0),
      };
    } catch (err) {
      if (err instanceof Error && /Account does not exist/i.test(err.message)) {
        return null;
      }
      // An account written under an older layout is not a failure to read the
      // chain, it is a migration waiting to happen — and it must not escape
      // from here, because the caller's own guard sits around the *write*.
      // Reporting it as unreadable lets that guard run.
      if (isUndersizedAccount(err)) return 'unreadable';
      throw err;
    }
  }
}
