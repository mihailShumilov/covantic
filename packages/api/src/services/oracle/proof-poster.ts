import anchorPkg from '@coral-xyz/anchor';
import type { PythSolanaReceiver } from '@pythnetwork/pyth-solana-receiver';
import {
  PublicKey,
  SystemProgram,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PDA_SEEDS } from '@covantic/shared';
import { logger } from '../../utils/logger.js';
import type { CovanticProgram } from '../../utils/program.js';
import type { ProofInputs } from '../verifiers/oracle-manipulation.js';
import { fetchAnchorAccount } from '../../utils/anchor-reader.js';
import type { SolanaReader } from '../../utils/solana-reader.js';

const { BN } = anchorPkg;

export interface ProvenPayoutRequest {
  holderAddress: string;
  policyId: bigint;
  payoutAmount: bigint;
  triggerBlockTime: number;
  proof: ProofInputs;
  /** sha256 of the canonical evidence bundle, hex. */
  bundleHash: string;
}

/**
 * Settle a claim on the path the chain can check.
 *
 * Two transactions' worth of work, packed by the Pyth receiver's builder:
 * first the historical Wormhole update is posted (the receiver verifies the
 * guardians' signatures as it writes the account), then
 * `verify_and_payout_v2` reads that account and re-derives the deviation for
 * itself. The oracle's assertion about the price stops being load-bearing.
 *
 * Timing constraint worth knowing about: the guardian set that signed the
 * update has to still be accepted on chain when it is posted. Guardian sets
 * roll over and old ones stop being honoured, so a proof must be posted
 * within the claim's lock window — hours — not recovered months later. The
 * archived update bytes keep off-chain replay valid indefinitely regardless.
 */
export class ProofPoster {
  private receiver: PythSolanaReceiver | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly ctx: CovanticProgram,
    private readonly reader: SolanaReader,
  ) {}

  /** Derive the evidence record PDA for a policy. */
  deriveEvidencePda(policyPda: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.CLAIM_EVIDENCE), policyPda.toBuffer()],
      this.ctx.programId,
    )[0];
  }

  /**
   * Post the signed price and execute the proven payout.
   *
   * Throws on any failure. The caller must treat that as "this claim could
   * not be proven" and escalate — never as licence to fall back to the
   * unverified instruction, which would make the whole path decorative.
   */
  async settle(request: ProvenPayoutRequest): Promise<string[]> {
    const oracleKeypair = this.ctx.oracleKeypair;
    if (!oracleKeypair) throw new Error('ProofPoster requires an oracle keypair');

    const holder = new PublicKey(request.holderAddress);
    const { config, vault, policy } = this.derivePdas(holder, request.policyId);

    // Protocol config over the endpoint pool: it names the covered mint and is
    // effectively immutable, so no endpoint's lag can change the answer, while
    // the payout below still goes out on the provider's own connection. Left
    // on that connection, a quota outage stalled settlement on every proven
    // path — the exact failure the pool exists to remove.
    const cfg = await fetchAnchorAccount<{ usdcMint: PublicKey }>(
      this.ctx,
      this.reader,
      'protocolConfig',
      config.toBase58(),
    );
    if (!cfg) throw new Error('proof-poster: protocol config account not found');
    const vaultAta = getAssociatedTokenAddressSync(cfg.usdcMint, vault, true);
    const holderAta = getAssociatedTokenAddressSync(cfg.usdcMint, holder);
    const evidenceRecord = this.deriveEvidencePda(policy);

    const receiver = await this.getReceiver();
    const builder = receiver.newTransactionBuilder({
      // Reclaim the rent: the update account exists only to be read by the
      // payout instruction in the same bundle.
      closeUpdateAccounts: true,
    });

    await builder.addPostPriceUpdates([toBase64(request.proof.signedUpdateHex)]);

    await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
      const priceUpdate = getPriceUpdateAccount(`0x${request.proof.feedIdHex}`);
      const methods = this.ctx.program.methods as unknown as Record<
        string,
        (...args: unknown[]) => {
          accounts: (a: Record<string, PublicKey>) => { instruction: () => Promise<TransactionInstruction> };
        }
      >;
      const instruction = await methods.verifyAndPayoutV2!(
        new BN(request.payoutAmount.toString()),
        {
          feedId: Array.from(Buffer.from(request.proof.feedIdHex, 'hex')),
          triggerBlockTime: new BN(request.triggerBlockTime),
          executedPrice: new BN(request.proof.executedPriceScaled),
          subjectQuantity: new BN(request.proof.subjectQuantity),
          subjectDecimals: request.proof.subjectDecimals,
          bundleHash: Array.from(Buffer.from(request.bundleHash, 'hex')),
        },
      )
        .accounts({
          oracle: oracleKeypair.publicKey,
          config,
          policy,
          vault,
          vaultTokenAccount: vaultAta,
          holderTokenAccount: holderAta,
          priceUpdate,
          evidenceRecord,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      return [{ instruction, signers: [] }];
    });

    const signatures = await receiver.provider.sendAll(
      await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000 }),
      { skipPreflight: false },
    );

    logger.info(
      {
        policyId: request.policyId.toString(),
        feed: request.proof.feedKey,
        signatures,
        evidenceRecord: evidenceRecord.toBase58(),
      },
      'proof-poster: proven payout settled on chain',
    );

    return signatures;
  }

  /**
   * Load the Pyth receiver on first use, not at import time.
   *
   * The import has to be dynamic, and the reason is worth recording because
   * it cost a production boot. `@pythnetwork/pyth-solana-receiver` pulls in
   * `@pythnetwork/solana-utils`, which imports `jito-ts` by an extensionless
   * path; Node's ESM resolver will not resolve that, so merely *loading* this
   * module throws `ERR_MODULE_NOT_FOUND` and takes the whole API process down
   * at startup. Nothing catches it, because it happens before any code runs.
   *
   * Deferring it to the first proven settlement matches what the dependency
   * is for. The proof paths are opt-in and off until the program carrying
   * them is deployed, so on a deployment that never posts a proof this
   * package is never loaded at all — and if it does fail, it fails inside a
   * claim that then stalls rather than taking the API with it.
   */
  private async getReceiver(): Promise<PythSolanaReceiver> {
    if (!this.receiver) {
      const { PythSolanaReceiver: Receiver } = await import(
        '@pythnetwork/pyth-solana-receiver'
      );
      this.receiver = new Receiver({
        connection: this.connection,
        wallet: this.ctx.provider.wallet as never,
      });
    }
    return this.receiver;
  }

  private derivePdas(holder: PublicKey, policyId: bigint) {
    const programId = this.ctx.programId;
    const [config] = PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.CONFIG)],
      programId,
    );
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.VAULT)], programId);
    const policyIdBuf = Buffer.alloc(8);
    policyIdBuf.writeBigUInt64LE(policyId);
    const [policy] = PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.POLICY), holder.toBuffer(), policyIdBuf],
      programId,
    );
    return { config, vault, policy };
  }
}

/** Hermes serves updates as hex; the receiver SDK takes base64. */
function toBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}
