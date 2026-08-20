import anchorPkg from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PDA_SEEDS } from '@covantic/shared';
import { logger } from '../../utils/logger.js';
import type { CovanticProgram } from '../../utils/program.js';
import type { MandateReader } from './mandate.js';

// Anchor's ESM export of BN trips up on named imports; pull from default.
const { BN } = anchorPkg;

export interface ProvenAgentErrorPayoutRequest {
  holderAddress: string;
  agentAddress: string;
  policyId: bigint;
  payoutAmount: bigint;
  /** sha256 of the canonical evidence bundle, hex. */
  bundleHash: string;
}

/**
 * Settle an agent-error claim on the path the chain can check.
 *
 * As short as the governance poster, and for the same reason. It carries a
 * payout amount and a bundle hash, and nothing else — the program reads the
 * holder's own matured mandate, the balance checkpoint the crank wrote
 * earlier, and the covered account's balance now, then decides for itself how
 * far outside the declared envelope the movement landed. This client cannot
 * influence any of it.
 *
 * `bundleHash` is the commitment to the off-chain evidence. The chain proves
 * the money left and that the amount exceeded a cap the holder signed for; the
 * bundle is the claim about everything the chain cannot see — where the value
 * went, what it was routed through — and committing to it makes a false claim
 * permanent and publicly falsifiable rather than invisible.
 *
 * Throws on any failure. The caller must treat that as "this claim could not
 * be proven" and escalate — never as licence to fall back to the unverified
 * instruction, which would make the whole path decorative.
 */
export class AgentErrorProofPoster {
  constructor(
    private readonly ctx: CovanticProgram,
    private readonly mandates: MandateReader,
  ) {}

  async settle(request: ProvenAgentErrorPayoutRequest): Promise<string> {
    const oracleKeypair = this.ctx.oracleKeypair;
    if (!oracleKeypair) throw new Error('AgentErrorProofPoster requires an oracle keypair');

    const holder = new PublicKey(request.holderAddress);
    const config = this.mandates.deriveConfigPda();
    const policy = this.mandates.derivePolicyPda(holder, request.policyId);

    const accounts = this.ctx.program.account as unknown as Record<
      string,
      { fetch: (address: PublicKey) => Promise<unknown> }
    >;
    const cfg = (await accounts.protocolConfig!.fetch(config)) as { usdcMint: PublicKey };

    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.VAULT)],
      this.ctx.programId,
    );

    const methods = this.ctx.program.methods as unknown as Record<
      string,
      (
        ...args: unknown[]
      ) => { accounts: (a: Record<string, PublicKey>) => { rpc: () => Promise<string> } }
    >;

    const signature = await methods
      .verifyAndPayoutAgentError!(new BN(request.payoutAmount.toString()), {
        bundleHash: Array.from(Buffer.from(request.bundleHash, 'hex')),
      })
      .accounts({
        oracle: oracleKeypair.publicKey,
        config,
        policy,
        vault,
        vaultTokenAccount: getAssociatedTokenAddressSync(cfg.usdcMint, vault, true),
        holderTokenAccount: getAssociatedTokenAddressSync(cfg.usdcMint, holder),
        // Derived the same way the program derives it. Passing the address is
        // a convenience for the transaction builder, not a choice: the program
        // recomputes it from the policy's own agent and rejects anything else.
        coveredTokenAccount: getAssociatedTokenAddressSync(
          cfg.usdcMint,
          new PublicKey(request.agentAddress),
        ),
        usdcMint: cfg.usdcMint,
        mandate: this.mandates.deriveMandatePda(policy),
        checkpoint: this.mandates.deriveCheckpointPda(policy),
        evidenceRecord: this.mandates.deriveAgentErrorEvidencePda(policy),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    logger.info(
      {
        policyId: request.policyId.toString(),
        signature,
        evidenceRecord: this.mandates.deriveAgentErrorEvidencePda(policy).toBase58(),
      },
      'agent-error-proof-poster: proven payout settled on chain',
    );

    return signature;
  }
}
