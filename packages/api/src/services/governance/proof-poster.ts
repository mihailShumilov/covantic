import anchorPkg from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PDA_SEEDS } from '@covantic/shared';
import { logger } from '../../utils/logger.js';
import type { CovanticProgram } from '../../utils/program.js';
import type { AuthorityCheckpointWriter } from './checkpoint.js';

// Anchor's ESM export of BN trips up on named imports; pull from default.
const { BN } = anchorPkg;

export interface ProvenGovernancePayoutRequest {
  holderAddress: string;
  agentAddress: string;
  policyId: bigint;
  payoutAmount: bigint;
  /** sha256 of the canonical evidence bundle, hex. */
  bundleHash: string;
}

/**
 * Settle a governance claim on the path the chain can check.
 *
 * The shortest of the four posters, and that is the point. It carries a
 * payout amount and a bundle hash, and nothing else — the program reads the
 * holder's own matured declaration, the authority checkpoint it wrote
 * earlier, and the covered account's current state, then decides for itself
 * whether control left the declared set and what the loss can be bounded at.
 * This client cannot influence any of it.
 *
 * `bundleHash` is the commitment to the off-chain evidence. The chain proves
 * control changed hands; the bundle is the claim about what that cost beyond
 * what the chain can see, and committing to it makes a false claim permanent
 * and publicly falsifiable rather than invisible.
 *
 * Throws on any failure. The caller must treat that as "this claim could not
 * be proven" and escalate — never as licence to fall back to the unverified
 * instruction, which would make the whole path decorative.
 */
export class GovernanceProofPoster {
  constructor(
    private readonly ctx: CovanticProgram,
    private readonly checkpoints: AuthorityCheckpointWriter,
  ) {}

  async settle(request: ProvenGovernancePayoutRequest): Promise<string> {
    const oracleKeypair = this.ctx.oracleKeypair;
    if (!oracleKeypair) throw new Error('GovernanceProofPoster requires an oracle keypair');

    const holder = new PublicKey(request.holderAddress);
    const config = this.checkpoints.deriveConfigPda();
    const policy = this.checkpoints.derivePolicyPda(holder, request.policyId);

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
      (...args: unknown[]) => {
        accounts: (a: Record<string, PublicKey>) => { rpc: () => Promise<string> };
      }
    >;

    const signature = await methods.verifyAndPayoutGovernance!(
      new BN(request.payoutAmount.toString()),
      {
        bundleHash: Array.from(Buffer.from(request.bundleHash, 'hex')),
      },
    )
      .accounts({
        oracle: oracleKeypair.publicKey,
        config,
        policy,
        vault,
        vaultTokenAccount: getAssociatedTokenAddressSync(cfg.usdcMint, vault, true),
        holderTokenAccount: getAssociatedTokenAddressSync(cfg.usdcMint, holder),
        // Derived the same way the program derives it. Passing the address is
        // a convenience for the transaction builder, not a choice: the
        // program recomputes it from the policy's own agent and rejects
        // anything else.
        coveredTokenAccount: getAssociatedTokenAddressSync(
          cfg.usdcMint,
          new PublicKey(request.agentAddress),
        ),
        usdcMint: cfg.usdcMint,
        baseline: this.checkpoints.deriveBaselinePda(policy),
        checkpoint: this.checkpoints.deriveAuthorityCheckpointPda(policy),
        evidenceRecord: this.checkpoints.deriveGovernanceEvidencePda(policy),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    logger.info(
      {
        policyId: request.policyId.toString(),
        signature,
        evidenceRecord: this.checkpoints.deriveGovernanceEvidencePda(policy).toBase58(),
      },
      'governance-proof-poster: proven payout settled on chain',
    );

    return signature;
  }
}
