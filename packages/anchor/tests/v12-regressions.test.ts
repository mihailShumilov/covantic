import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { AnchorProvider, BN, Program, utils, type Idl } from '@coral-xyz/anchor';
import { agentMandateCommitment } from '@covantic/shared';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createApproveInstruction,
  createAssociatedTokenAccountInstruction,
  createFreezeAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
} from '@solana/spl-token';
import { BankrunProvider } from 'anchor-bankrun';
import { Clock, startAnchor, type ProgramTestContext, type BanksClient } from 'solana-bankrun';

/**
 * Regressions for the findings of the V12 audit of commit 11b28f6.
 *
 * Each block names the finding it closes. The proofs of concept in that
 * report drove the vulnerable behaviour through the public instruction
 * surface in this same harness; these tests drive the same sequences and
 * assert the program now refuses — or, where the finding was a denial of a
 * legitimate payout, that it now pays.
 */

const IDL_PATH = resolve(__dirname, '../target/idl/covantic.json');
const hasIdl = existsSync(IDL_PATH);
const loadIdl = (): Idl => JSON.parse(readFileSync(IDL_PATH, 'utf-8')) as Idl;
const PROGRAM_ID = new PublicKey(
  hasIdl
    ? ((JSON.parse(readFileSync(IDL_PATH, 'utf-8')) as { address?: string }).address ??
        'HrLqdNdxUJq4pgsL4NsUqzfYrGxR7Hy9PHGEeHnj3skL')
    : 'HrLqdNdxUJq4pgsL4NsUqzfYrGxR7Hy9PHGEeHnj3skL',
);
const PYTH_RECEIVER_PROGRAM_ID = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');

const seed = (s: string) => Buffer.from(s);
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const configPda = () => pda([seed('covantic_config')]);
const vaultPda = () => pda([seed('covantic_vault')]);
const stakerPda = (k: PublicKey) => pda([seed('covantic_staker'), k.toBuffer()]);
const attestationPda = (agent: PublicKey) => pda([seed('covantic_attestation'), agent.toBuffer()]);
const policyPda = (holder: PublicKey, id: BN) =>
  pda([seed('covantic_policy'), holder.toBuffer(), id.toArrayLike(Buffer, 'le', 8)]);
const mandatePda = (p: PublicKey) => pda([seed('covantic_agent_mandate'), p.toBuffer()]);
const balanceCheckpointPda = (p: PublicKey) => pda([seed('covantic_checkpoint'), p.toBuffer()]);
const authorityCheckpointPda = (p: PublicKey) =>
  pda([seed('covantic_authority_checkpoint'), p.toBuffer()]);
const priceTermsPda = (p: PublicKey) => pda([seed('covantic_price_terms'), p.toBuffer()]);
const baselinePda = (p: PublicKey) => pda([seed('covantic_gov_baseline'), p.toBuffer()]);
const govEvidencePda = (p: PublicKey) => pda([seed('covantic_gov_evidence'), p.toBuffer()]);
const claimEvidencePda = (p: PublicKey) => pda([seed('covantic_claim_evidence'), p.toBuffer()]);
const exploitEvidencePda = (p: PublicKey) => pda([seed('covantic_exploit_evidence'), p.toBuffer()]);

const USDC_DECIMALS = 6;
const usdc = (n: number) => new BN(n * 10 ** USDC_DECIMALS);
const HOUR = 3_600;
const DAY = 24 * HOUR;
const GOVERNANCE_LOCK = 2 * HOUR;
const DRAIN_WINDOW = 30 * 60;
const CLAIM_RESOLUTION_GRACE = 7 * DAY;

/** The Base58 text of a 64-byte signature, as UTF-8 — what a claim carries. */
const triggerSig = (seedByte: number): Buffer =>
  Buffer.from(utils.bytes.bs58.encode(Buffer.alloc(64, seedByte)), 'utf8');

const FEED_A = Buffer.alloc(32, 0xa1);
const FEED_B = Buffer.alloc(32, 0xb2);
const SUBJECT_MINT = Keypair.generate().publicKey;

function priceTerms(feed: Buffer, maxQuantity: number) {
  return {
    feedId: Array.from(feed),
    subjectMint: SUBJECT_MINT,
    subjectDecimals: 0,
    maxSubjectQuantity: new BN(maxQuantity),
  };
}
const noPriceTerms = () => ({
  feedId: Array.from(new Uint8Array(32)),
  subjectMint: PublicKey.default,
  subjectDecimals: 0,
  maxSubjectQuantity: new BN(0),
});

/**
 * A `PriceUpdateV2` account as the Pyth receiver writes it, at $1.00 with
 * exponent -8. Borsh: discriminator, `write_authority`, then the
 * `VerificationLevel` enum — `Partial { num_signatures }` is tag 0 followed
 * by one byte, `Full` is tag 1 alone — then the price message and the posted
 * slot. The harness cannot run the receiver, so the account is injected;
 * what is under test is which of the two levels the program will read a
 * settlement price from.
 */
function priceUpdateData(feedId: Buffer, publishTime: bigint, full: boolean): Buffer {
  const data = Buffer.alloc(full ? 133 : 134);
  createHash('sha256').update('account:PriceUpdateV2').digest().copy(data, 0, 0, 8);
  let at = 40;
  if (full) {
    data[at] = 1; // VerificationLevel::Full
    at += 1;
  } else {
    data[at] = 0; // VerificationLevel::Partial
    data[at + 1] = 1; // num_signatures: one guardian, not two thirds
    at += 2;
  }
  feedId.copy(data, at);
  at += 32;
  data.writeBigInt64LE(100_000_000n, at); // price
  data.writeBigUInt64LE(1n, at + 8); // conf
  data.writeInt32LE(-8, at + 16); // exponent
  data.writeBigInt64LE(publishTime, at + 20);
  data.writeBigInt64LE(publishTime - 1n, at + 28); // prev_publish_time
  data.writeBigInt64LE(100_000_000n, at + 36); // ema_price
  data.writeBigUInt64LE(1n, at + 44); // ema_conf
  data.writeBigUInt64LE(1n, at + 52); // posted_slot
  return data;
}

async function advanceSlots(context: ProgramTestContext, slots: number): Promise<void> {
  const clock = await context.banksClient.getClock();
  context.warpToSlot(clock.slot + BigInt(slots));
}

async function advanceClockBySeconds(context: ProgramTestContext, seconds: number): Promise<void> {
  const current = await context.banksClient.getClock();
  context.warpToSlot(current.slot + 1n);
  const warped = await context.banksClient.getClock();
  context.setClock(
    new Clock(
      warped.slot,
      warped.epochStartTimestamp,
      warped.epoch,
      warped.leaderScheduleEpoch,
      current.unixTimestamp + BigInt(seconds),
    ),
  );
}

function airdrop(context: ProgramTestContext, account: PublicKey): void {
  context.setAccount(account, {
    lamports: 50_000_000_000,
    data: Buffer.alloc(0),
    owner: SystemProgram.programId,
    executable: false,
  });
}

describe.skipIf(!hasIdl)('V12 remediation regressions', () => {
  let context: ProgramTestContext;
  let banks: BanksClient;
  let provider: BankrunProvider;
  let program: Program<Idl>;

  const admin = Keypair.generate();
  const oracle = Keypair.generate();
  const holder = Keypair.generate();
  const staker = Keypair.generate();
  const attacker = Keypair.generate();
  const usdcMint = Keypair.generate();

  let holderAta: PublicKey;
  let stakerAta: PublicKey;
  let vaultAta: PublicKey;

  const wideMandate = () => ({
    maxSingleOutflow: usdc(1_000_000),
    maxWindowOutflow: usdc(1_000_000),
    windowSeconds: new BN(HOUR),
    minRetainedBalance: new BN(0),
    allowedCounterparties: [],
    allowedPrograms: [],
    manifestHash: Array.from(new Uint8Array(32)),
  });
  const wideMandateHash = () =>
    Array.from(
      agentMandateCommitment({
        maxSingleOutflowRaw: BigInt(usdc(1_000_000).toString()),
        maxWindowOutflowRaw: BigInt(usdc(1_000_000).toString()),
        windowSeconds: BigInt(HOUR),
        minRetainedBalanceRaw: 0n,
        allowedCounterparties: [],
        allowedPrograms: [],
      }),
    );

  async function send(tx: Transaction, signers: Keypair[]): Promise<void> {
    tx.recentBlockhash = (await banks.getLatestBlockhash())[0];
    tx.feePayer = admin.publicKey;
    tx.sign(...signers);
    await banks.processTransaction(tx);
  }

  beforeAll(async () => {
    context = await startAnchor(resolve(__dirname, '..'), [], []);
    banks = context.banksClient;
    provider = new BankrunProvider(context);
    program = new Program(loadIdl(), provider as unknown as AnchorProvider);

    for (const kp of [admin, oracle, holder, staker, attacker]) airdrop(context, kp.publicKey);

    const lamports = await getMinimumBalanceForRentExemptMint(provider.connection as any);
    await send(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: usdcMint.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(
          usdcMint.publicKey,
          USDC_DECIMALS,
          admin.publicKey,
          admin.publicKey, // freeze authority, for the freeze cases
          TOKEN_PROGRAM_ID,
        ),
      ),
      [admin, usdcMint],
    );

    vaultAta = getAssociatedTokenAddressSync(usdcMint.publicKey, vaultPda(), true);
    holderAta = getAssociatedTokenAddressSync(usdcMint.publicKey, holder.publicKey);
    stakerAta = getAssociatedTokenAddressSync(usdcMint.publicKey, staker.publicKey);
    await send(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          admin.publicKey,
          holderAta,
          holder.publicKey,
          usdcMint.publicKey,
        ),
        createAssociatedTokenAccountInstruction(
          admin.publicKey,
          stakerAta,
          staker.publicKey,
          usdcMint.publicKey,
        ),
        createMintToInstruction(
          usdcMint.publicKey,
          holderAta,
          admin.publicKey,
          100_000n * 10n ** 6n,
        ),
        createMintToInstruction(
          usdcMint.publicKey,
          stakerAta,
          admin.publicKey,
          100_000n * 10n ** 6n,
        ),
      ),
      [admin],
    );

    await program.methods
      .initialize(oracle.publicKey)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda(),
        vault: vaultPda(),
        usdcMint: usdcMint.publicKey,
        vaultTokenAccount: vaultAta,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([admin])
      .rpc();

    await program.methods
      .stake(usdc(50_000))
      .accountsPartial({
        staker: staker.publicKey,
        config: configPda(),
        vault: vaultPda(),
        stakerPosition: stakerPda(staker.publicKey),
        stakerTokenAccount: stakerAta,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([staker])
      .rpc();
  });

  // ---- helpers ------------------------------------------------------------

  async function newAgent(funding: BN): Promise<{ agent: Keypair; agentAta: PublicKey }> {
    const agent = Keypair.generate();
    airdrop(context, agent.publicKey);
    const agentAta = getAssociatedTokenAddressSync(usdcMint.publicKey, agent.publicKey);
    await send(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          admin.publicKey,
          agentAta,
          agent.publicKey,
          usdcMint.publicKey,
        ),
        createMintToInstruction(
          usdcMint.publicKey,
          agentAta,
          admin.publicKey,
          BigInt(funding.toString()),
        ),
      ),
      [admin],
    );
    return { agent, agentAta };
  }

  async function attest(agent: PublicKey, terms = noPriceTerms()): Promise<void> {
    await program.methods
      .upsertAttestation(agent, 0, new BN(HOUR), wideMandateHash(), new BN(0), terms)
      .accountsPartial({
        oracle: oracle.publicKey,
        config: configPda(),
        attestation: attestationPda(agent),
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([oracle])
      .rpc();
  }

  async function buyPolicy(
    agent: PublicKey,
    coverage: BN,
    durationSeconds = DAY,
  ): Promise<{ policy: PublicKey; policyId: BN }> {
    const cfg: any = await (program.account as any).protocolConfig.fetch(configPda());
    const policyId = cfg.policyCounter as BN;
    const policy = policyPda(holder.publicKey, policyId);
    await program.methods
      .createPolicy(coverage, new BN(durationSeconds), agent, wideMandate() as any)
      .accountsPartial({
        holder: holder.publicKey,
        config: configPda(),
        vault: vaultPda(),
        attestation: attestationPda(agent),
        policy,
        mandate: mandatePda(policy),
        checkpoint: balanceCheckpointPda(policy),
        authorityCheckpoint: authorityCheckpointPda(policy),
        priceTerms: priceTermsPda(policy),
        coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent),
        usdcMint: usdcMint.publicKey,
        holderTokenAccount: holderAta,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([holder])
      .rpc();
    return { policy, policyId };
  }

  async function setupPolicy(
    coverage: BN,
    funding: BN,
    terms = noPriceTerms(),
    durationSeconds = DAY,
  ) {
    const { agent, agentAta } = await newAgent(funding);
    await attest(agent.publicKey, terms);
    const { policy, policyId } = await buyPolicy(agent.publicKey, coverage, durationSeconds);
    return { agent, agentAta, policy, policyId };
  }

  const holderClaim = (policy: PublicKey, trigger: number, sig: Buffer) =>
    program.methods
      .submitClaim(trigger, sig)
      .accountsPartial({ holder: holder.publicKey, policy } as any)
      .signers([holder]);

  async function oracleClaim(policy: PublicKey, trigger: number, sigSeed = 7): Promise<void> {
    await program.methods
      .oracleSubmitClaim(trigger, triggerSig(sigSeed))
      .accountsPartial({ oracle: oracle.publicKey, config: configPda(), policy } as any)
      .signers([oracle])
      .rpc();
  }

  async function checkpointAuthority(policy: PublicKey, agent: PublicKey): Promise<void> {
    await program.methods
      .checkpointAuthority()
      .accountsPartial({
        cranker: admin.publicKey,
        config: configPda(),
        policy,
        coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent),
        usdcMint: usdcMint.publicKey,
        checkpoint: authorityCheckpointPda(policy),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([admin])
      .rpc();
  }

  function manifest(agent: PublicKey, overrides: Record<string, unknown> = {}) {
    return {
      tokenOwner: agent,
      expectedDelegate: null,
      expectedCloseAuthority: null,
      programUpgradeAuthority: null,
      controller: null,
      controllerMinThreshold: 0,
      extraAuthorities: [],
      manifestHash: Array.from(Buffer.alloc(32, 7)),
      ...overrides,
    };
  }

  function declare(policy: PublicKey, agent: PublicKey, overrides: Record<string, unknown> = {}) {
    return program.methods
      .declareGovernanceBaseline(manifest(agent, overrides) as any)
      .accountsPartial({
        holder: holder.publicKey,
        config: configPda(),
        policy,
        coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent),
        usdcMint: usdcMint.publicKey,
        baseline: baselinePda(policy),
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([holder]);
  }

  async function seize(agent: Keypair, agentAta: PublicKey, to: PublicKey): Promise<void> {
    await send(
      new Transaction().add(
        createSetAuthorityInstruction(agentAta, agent.publicKey, AuthorityType.AccountOwner, to),
      ),
      [admin, agent],
    );
  }

  async function freeze(agentAta: PublicKey): Promise<void> {
    await send(
      new Transaction().add(
        createFreezeAccountInstruction(agentAta, usdcMint.publicKey, admin.publicKey),
      ),
      [admin],
    );
  }

  async function drain(agent: Keypair, agentAta: PublicKey, amount: BN): Promise<void> {
    await send(
      new Transaction().add(
        createTransferInstruction(agentAta, stakerAta, agent.publicKey, BigInt(amount.toString())),
      ),
      [admin, agent],
    );
  }

  function govPayout(policy: PublicKey, agent: PublicKey, amount: BN, bundle = 4) {
    return program.methods
      .verifyAndPayoutGovernance(amount, { bundleHash: Array.from(Buffer.alloc(32, bundle)) })
      .accountsPartial({
        oracle: oracle.publicKey,
        config: configPda(),
        policy,
        vault: vaultPda(),
        vaultTokenAccount: vaultAta,
        holderTokenAccount: holderAta,
        coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent),
        usdcMint: usdcMint.publicKey,
        baseline: baselinePda(policy),
        checkpoint: authorityCheckpointPda(policy),
        evidenceRecord: govEvidencePda(policy),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([oracle]);
  }

  function exploitPayout(policy: PublicKey, agent: PublicKey, amount: BN, bundle = 9) {
    return program.methods
      .verifyAndPayoutExploit(amount, { bundleHash: Array.from(Buffer.alloc(32, bundle)) })
      .accountsPartial({
        oracle: oracle.publicKey,
        config: configPda(),
        policy,
        vault: vaultPda(),
        vaultTokenAccount: vaultAta,
        holderTokenAccount: holderAta,
        coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint.publicKey, agent),
        usdcMint: usdcMint.publicKey,
        checkpoint: balanceCheckpointPda(policy),
        evidenceRecord: exploitEvidencePda(policy),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([oracle]);
  }

  function pricePayout(
    policy: PublicKey,
    priceAccount: PublicKey,
    evidence: {
      feedId: Buffer;
      triggerBlockTime: bigint;
      subjectQuantity: number;
      bundle: number;
    },
    amount: BN,
  ) {
    return program.methods
      .verifyAndPayoutV2(amount, {
        feedId: Array.from(evidence.feedId),
        triggerBlockTime: new BN(evidence.triggerBlockTime.toString()),
        executedPrice: new BN(200_000_000), // $2.00 against a $1.00 reference
        subjectQuantity: new BN(evidence.subjectQuantity),
        subjectDecimals: 0,
        bundleHash: Array.from(Buffer.alloc(32, evidence.bundle)),
      })
      .accountsPartial({
        oracle: oracle.publicKey,
        config: configPda(),
        policy,
        vault: vaultPda(),
        vaultTokenAccount: vaultAta,
        holderTokenAccount: holderAta,
        priceUpdate: priceAccount,
        priceTerms: priceTermsPda(policy),
        evidenceRecord: claimEvidencePda(policy),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([oracle]);
  }

  function injectPriceUpdate(feed: Buffer, publishTime: bigint, full: boolean): PublicKey {
    const account = Keypair.generate().publicKey;
    context.setAccount(account, {
      lamports: 1_000_000,
      data: priceUpdateData(feed, publishTime, full),
      owner: PYTH_RECEIVER_PROGRAM_ID,
      executable: false,
    });
    return account;
  }

  const expire = (policy: PublicKey) =>
    program.methods
      .expirePolicy()
      .accountsPartial({ cranker: admin.publicKey, policy, vault: vaultPda() } as any)
      .signers([admin]);

  // ---- 15: the unverified settlement instruction is gone -----------------

  describe('legacy settlement (finding 15)', () => {
    it('no longer exports verify_and_payout', () => {
      // The raw IDL on disk keeps snake_case names; the client camel-cases
      // them. Check both, so neither spelling can quietly come back.
      const raw = (loadIdl().instructions as Array<{ name: string }>).map((i) => i.name);
      expect(raw).not.toContain('verify_and_payout');
      expect(raw).toContain('verify_and_payout_v2');
      expect(raw).toContain('verify_and_payout_exploit');
      expect(raw).toContain('verify_and_payout_governance');
      expect(raw).toContain('verify_and_payout_agent_error');
      const methods = program.methods as Record<string, unknown>;
      expect(methods.verifyAndPayout).toBeUndefined();
      expect(methods.verifyAndPayoutV2).toBeDefined();
    });
  });

  // ---- purchase writes the accounts later proofs rest on -----------------

  describe('purchase-time records', () => {
    it('writes a predecessor-less authority reading with the agent as owner', async () => {
      const { agent, policy } = await setupPolicy(usdc(100), usdc(100));
      const cp: any = await (program.account as any).policyAuthorityCheckpoint.fetch(
        authorityCheckpointPda(policy),
      );
      expect(cp.owner.toBase58()).toBe(agent.publicKey.toBase58());
      expect(cp.frozen).toBe(false);
      expect(cp.amount.toString()).toBe(usdc(100).toString());
      expect(cp.prevSlot.toString()).toBe('0');
      expect(cp.prevUnixTimestamp.toString()).toBe('0');
    });

    it('copies the attested price terms into the policy', async () => {
      const { policy } = await setupPolicy(usdc(100), usdc(100), priceTerms(FEED_A, 250));
      const terms: any = await (program.account as any).policyPriceTerms.fetch(
        priceTermsPda(policy),
      );
      expect(Buffer.from(terms.feedId)).toEqual(FEED_A);
      expect(terms.subjectMint.toBase58()).toBe(SUBJECT_MINT.toBase58());
      expect(terms.maxSubjectQuantity.toString()).toBe('250');
    });

    it('refuses an attestation with half a set of price terms', async () => {
      const { agent } = await newAgent(usdc(1));
      await expect(
        attest(agent.publicKey, { ...noPriceTerms(), feedId: Array.from(FEED_A) }),
      ).rejects.toThrow();
    });
  });

  // ---- 6: malformed trigger signatures -----------------------------------

  describe('trigger transaction signatures (finding 6)', () => {
    it('refuses raw signature bytes and off-alphabet text, and accepts Base58', async () => {
      const { policy } = await setupPolicy(usdc(100), usdc(100));

      // Sixty-four raw bytes — what the old harness stored.
      await expect(holderClaim(policy, 1, Buffer.alloc(64, 0x11)).rpc()).rejects.toThrow();
      // The right length, the wrong alphabet.
      const bad = Buffer.from(triggerSig(3).toString('utf8').replace(/./, '0'), 'utf8');
      await expect(holderClaim(policy, 1, bad).rpc()).rejects.toThrow();
      // A 32-byte key in Base58 is valid text of the wrong size.
      await expect(
        holderClaim(policy, 1, Buffer.from(PublicKey.default.toBase58(), 'utf8')).rpc(),
      ).rejects.toThrow();

      const still: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(still.state).toBe(0); // Active: nothing parked it

      await holderClaim(policy, 1, triggerSig(3)).rpc();
      const pending: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(pending.state).toBe(1);
      expect(Buffer.from(pending.triggerTxSignature).toString('utf8')).toBe(
        triggerSig(3).toString('utf8'),
      );
    });

    it('holds the oracle path to the same rule', async () => {
      const { policy } = await setupPolicy(usdc(100), usdc(100));
      await expect(
        program.methods
          .oracleSubmitClaim(1, Buffer.alloc(64, 0x22))
          .accountsPartial({ oracle: oracle.publicKey, config: configPda(), policy } as any)
          .signers([oracle])
          .rpc(),
      ).rejects.toThrow();
    });
  });

  // ---- 1, 2, 9, 10: the price proof ---------------------------------------

  describe('price proof (findings 1, 2, 9, 10)', () => {
    async function pendingPriceClaim(terms = priceTerms(FEED_A, 100)) {
      const { policy } = await setupPolicy(usdc(100), usdc(100), terms);
      await oracleClaim(policy, 2, 2);
      const clock = await banks.getClock();
      const triggerBlockTime = clock.unixTimestamp;
      await advanceClockBySeconds(context, HOUR + 1);
      return { policy, triggerBlockTime };
    }

    it('refuses a partially verified update and accepts the full quorum', async () => {
      const { policy, triggerBlockTime } = await pendingPriceClaim();
      const evidence = { feedId: FEED_A, triggerBlockTime, subjectQuantity: 100, bundle: 5 };

      const partial = injectPriceUpdate(FEED_A, triggerBlockTime, false);
      await expect(pricePayout(policy, partial, evidence, usdc(100)).rpc()).rejects.toThrow();

      const full = injectPriceUpdate(FEED_A, triggerBlockTime, true);
      await pricePayout(policy, full, evidence, usdc(100)).rpc();

      const record: any = await (program.account as any).claimEvidenceRecord.fetch(
        claimEvidencePda(policy),
      );
      expect(record.deviationBps).toBe(10_000);
      expect(record.maxProvableLoss.toString()).toBe(usdc(100).toString());
      const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(pol.state).toBe(2);
    });

    it('refuses a feed the policy does not insure', async () => {
      const { policy, triggerBlockTime } = await pendingPriceClaim();
      const full = injectPriceUpdate(FEED_B, triggerBlockTime, true);
      await expect(
        pricePayout(
          policy,
          full,
          { feedId: FEED_B, triggerBlockTime, subjectQuantity: 100, bundle: 5 },
          usdc(100),
        ).rpc(),
      ).rejects.toThrow();
    });

    it('refuses a quantity above the attested bound', async () => {
      const { policy, triggerBlockTime } = await pendingPriceClaim();
      const full = injectPriceUpdate(FEED_A, triggerBlockTime, true);
      await expect(
        pricePayout(
          policy,
          full,
          { feedId: FEED_A, triggerBlockTime, subjectQuantity: 101, bundle: 5 },
          usdc(100),
        ).rpc(),
      ).rejects.toThrow();
      // Inside the bound, the same claim pays.
      await advanceSlots(context, 1);
      await pricePayout(
        policy,
        full,
        { feedId: FEED_A, triggerBlockTime, subjectQuantity: 100, bundle: 5 },
        usdc(100),
      ).rpc();
    });

    it('refuses a policy bought with no price terms at all', async () => {
      const { policy, triggerBlockTime } = await pendingPriceClaim(noPriceTerms());
      const full = injectPriceUpdate(FEED_A, triggerBlockTime, true);
      await expect(
        pricePayout(
          policy,
          full,
          { feedId: FEED_A, triggerBlockTime, subjectQuantity: 100, bundle: 5 },
          usdc(100),
        ).rpc(),
      ).rejects.toThrow();
    });

    it('refuses a zero evidence hash on every proof path', async () => {
      const { policy, triggerBlockTime } = await pendingPriceClaim();
      const full = injectPriceUpdate(FEED_A, triggerBlockTime, true);
      await expect(
        pricePayout(
          policy,
          full,
          { feedId: FEED_A, triggerBlockTime, subjectQuantity: 100, bundle: 0 },
          usdc(100),
        ).rpc(),
      ).rejects.toThrow();

      const exploit = await setupPolicy(usdc(100), usdc(100));
      await drain(exploit.agent, exploit.agentAta, usdc(90));
      await oracleClaim(exploit.policy, 1, 1);
      await advanceClockBySeconds(context, HOUR + 1);
      await expect(
        exploitPayout(exploit.policy, exploit.agent.publicKey, usdc(90), 0).rpc(),
      ).rejects.toThrow();
      await exploitPayout(exploit.policy, exploit.agent.publicKey, usdc(90), 9).rpc();
    });
  });

  // ---- 3, 13, 19, 20, 23, 24, 26: governance ------------------------------

  describe('governance proof (findings 3, 13, 19, 20, 23, 24, 26)', () => {
    it('refuses a manifest naming roles the program cannot observe (13)', async () => {
      const { agent, policy } = await setupPolicy(usdc(100), usdc(100));
      await expect(
        declare(policy, agent.publicKey, { programUpgradeAuthority: attacker.publicKey }).rpc(),
      ).rejects.toThrow();
      await expect(
        declare(policy, agent.publicKey, { controller: attacker.publicKey }).rpc(),
      ).rejects.toThrow();
      await expect(
        declare(policy, agent.publicKey, { controllerMinThreshold: 2 }).rpc(),
      ).rejects.toThrow();
    });

    it('refuses the zero key as an optional role (24)', async () => {
      const { agent, policy } = await setupPolicy(usdc(100), usdc(100));
      await expect(
        declare(policy, agent.publicKey, { expectedDelegate: PublicKey.default }).rpc(),
      ).rejects.toThrow();
      await expect(
        declare(policy, agent.publicKey, { expectedCloseAuthority: PublicKey.default }).rpc(),
      ).rejects.toThrow();
    });

    it('refuses a declaration the account does not currently satisfy (20)', async () => {
      const { agent, agentAta, policy } = await setupPolicy(usdc(100), usdc(100));
      await seize(agent, agentAta, attacker.publicKey);
      // The agent is named as owner, but the attacker holds the account.
      await expect(declare(policy, agent.publicKey).rpc()).rejects.toThrow();

      const other = await setupPolicy(usdc(100), usdc(100));
      await send(
        new Transaction().add(
          createApproveInstruction(other.agentAta, attacker.publicKey, other.agent.publicKey, 1n),
        ),
        [admin, other.agent],
      );
      // An undeclared delegate is outside the set too — and declaring it
      // makes the declaration acceptable.
      await expect(declare(other.policy, other.agent.publicKey).rpc()).rejects.toThrow();
      await declare(other.policy, other.agent.publicKey, {
        expectedDelegate: attacker.publicKey,
      }).rpc();
    });

    it('will not pay a takeover no permitted reading in the window precedes (20, 23)', async () => {
      // The V12 sequence: the outside key is installed before any crank tick,
      // and the first reading the crank takes already shows it. The purchase
      // reading is the only permitted one, and by the time the declaration
      // has matured it is an hour old — outside the drain window and older
      // than the declaration itself.
      const { agent, agentAta, policy } = await setupPolicy(usdc(100), usdc(100));
      await declare(policy, agent.publicKey).rpc();
      await seize(agent, agentAta, attacker.publicKey);
      await advanceClockBySeconds(context, HOUR + 1);
      await checkpointAuthority(policy, agent.publicKey); // first crank reading: attacker
      await oracleClaim(policy, 4, 11);
      await advanceClockBySeconds(context, GOVERNANCE_LOCK + 1);

      await expect(govPayout(policy, agent.publicKey, usdc(100)).rpc()).rejects.toThrow();
      const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(pol.state).toBe(1);
    });

    it('pays a seizure the program watched happen from a permitted reading (20)', async () => {
      const { agent, agentAta, policy } = await setupPolicy(usdc(100), usdc(100));
      await declare(policy, agent.publicKey).rpc();
      await advanceClockBySeconds(context, HOUR + 1);
      await checkpointAuthority(policy, agent.publicKey); // permitted, matured, fresh
      await seize(agent, agentAta, attacker.publicKey);
      await advanceSlots(context, 1);
      await checkpointAuthority(policy, agent.publicKey); // the crank sees the aftermath
      await oracleClaim(policy, 4, 11);
      await advanceClockBySeconds(context, GOVERNANCE_LOCK + 1);

      await govPayout(policy, agent.publicKey, usdc(100)).rpc();
      const record: any = await (program.account as any).governanceEvidenceRecord.fetch(
        govEvidencePda(policy),
      );
      expect(record.departureKind).toBe(1);
      expect(record.departedTo.toBase58()).toBe(attacker.publicKey.toBase58());
      expect(record.seizedAmount.toString()).toBe(usdc(100).toString());
    });

    it('refuses a permitted reading older than the drain window (3)', async () => {
      const { agent, agentAta, policy } = await setupPolicy(usdc(100), usdc(100));
      await declare(policy, agent.publicKey).rpc();
      await advanceClockBySeconds(context, HOUR + 1);
      await checkpointAuthority(policy, agent.publicKey);
      await advanceClockBySeconds(context, DRAIN_WINDOW + 60);
      await seize(agent, agentAta, attacker.publicKey);
      await oracleClaim(policy, 4, 11);
      await advanceClockBySeconds(context, GOVERNANCE_LOCK + 1);

      await expect(govPayout(policy, agent.publicKey, usdc(100)).rpc()).rejects.toThrow();
    });

    it('still pays a freeze after the frozen account was checkpointed repeatedly (19)', async () => {
      const { agent, agentAta, policy } = await setupPolicy(usdc(100), usdc(100));
      await declare(policy, agent.publicKey).rpc();
      await advanceClockBySeconds(context, HOUR + 1);
      await checkpointAuthority(policy, agent.publicKey);
      await freeze(agentAta);
      // Anyone may crank, and cranking a frozen account three more times
      // used to overwrite the only unfrozen predecessor.
      for (let i = 0; i < 3; i += 1) {
        await advanceSlots(context, 1);
        await checkpointAuthority(policy, agent.publicKey);
      }
      const cp: any = await (program.account as any).policyAuthorityCheckpoint.fetch(
        authorityCheckpointPda(policy),
      );
      expect(cp.frozen).toBe(true);
      expect(cp.prevFrozen).toBe(false);

      await oracleClaim(policy, 4, 11);
      await advanceClockBySeconds(context, GOVERNANCE_LOCK + 1);
      await govPayout(policy, agent.publicKey, usdc(100)).rpc();
      const record: any = await (program.account as any).governanceEvidenceRecord.fetch(
        govEvidencePda(policy),
      );
      expect(record.departureKind).toBe(2);
    });

    it('judges a claim by the declaration in force, not an immature refresh (26)', async () => {
      const { agent, agentAta, policy } = await setupPolicy(usdc(100), usdc(100));
      await declare(policy, agent.publicKey).rpc();
      await advanceClockBySeconds(context, HOUR + 1);
      // A refresh that names an operator. It will not have matured when the
      // claim is filed, so the settlement must fall back to the declaration
      // it replaced — whole, not just its owner.
      await declare(policy, agent.publicKey, { extraAuthorities: [staker.publicKey] }).rpc();
      const b: any = await (program.account as any).governanceBaseline.fetch(baselinePda(policy));
      expect(b.prevTokenOwner.toBase58()).toBe(agent.publicKey.toBase58());
      expect(b.prevEffectiveAt.toNumber()).toBeGreaterThan(0);
      expect(Buffer.from(b.prevManifestHash)).toEqual(Buffer.alloc(32, 7));

      await checkpointAuthority(policy, agent.publicKey);
      await seize(agent, agentAta, attacker.publicKey);
      await oracleClaim(policy, 4, 11);
      await advanceClockBySeconds(context, GOVERNANCE_LOCK + 1);

      await govPayout(policy, agent.publicKey, usdc(100)).rpc();
      const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(pol.state).toBe(2);
    });

    it('grows accounts idempotently through the migration instructions', async () => {
      const { agent, policy } = await setupPolicy(usdc(100), usdc(100));
      await declare(policy, agent.publicKey).rpc();
      const before = await banks.getAccount(baselinePda(policy));
      await program.methods
        .migrateGovernanceBaseline()
        .accountsPartial({
          payer: admin.publicKey,
          baseline: baselinePda(policy),
          policy,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([admin])
        .rpc();
      await program.methods
        .migrateAuthorityCheckpoint()
        .accountsPartial({
          payer: admin.publicKey,
          checkpoint: authorityCheckpointPda(policy),
          policy,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([admin])
        .rpc();
      const after = await banks.getAccount(baselinePda(policy));
      expect(after!.data.length).toBe(before!.data.length);
    });
  });

  // ---- 18: pending claims no longer reserve coverage forever --------------

  describe('unresolved pending claims (finding 18)', () => {
    it('lets the crank close a pending claim once its lock and grace have run out', async () => {
      const { policy } = await setupPolicy(usdc(100), usdc(100), noPriceTerms(), HOUR);
      await holderClaim(policy, 1, triggerSig(5)).rpc();
      const vaultBefore: any = await (program.account as any).insuranceVault.fetch(vaultPda());

      // Past expiry, but the claim is still inside its lock and grace.
      await advanceClockBySeconds(context, HOUR + 1);
      await expect(expire(policy).rpc()).rejects.toThrow();

      // Past the lock and the grace: the policy closes and the coverage is
      // released, with nobody paid.
      await advanceClockBySeconds(context, CLAIM_RESOLUTION_GRACE + HOUR);
      await expire(policy).rpc();
      const pol: any = await (program.account as any).insurancePolicy.fetch(policy);
      expect(pol.state).toBe(3);
      const vaultAfter: any = await (program.account as any).insuranceVault.fetch(vaultPda());
      expect(
        BigInt(vaultBefore.totalCoverage.toString()) - BigInt(vaultAfter.totalCoverage.toString()),
      ).toBe(BigInt(usdc(100).toString()));
    });
  });

  // ---- 7, 8: persisted bytes the program was not written for --------------

  describe('policy schema version (findings 7, 8)', () => {
    it('refuses to touch a policy carrying an unsupported version byte', async () => {
      const { policy } = await setupPolicy(usdc(100), usdc(100), noPriceTerms(), HOUR);
      await advanceClockBySeconds(context, HOUR + 1);

      const account = (await banks.getAccount(policy))!;
      const data = Buffer.from(account.data);
      expect(data[8]).toBe(1); // version sits right after the discriminator
      data[8] = 0;
      context.setAccount(policy, {
        lamports: Number(account.lamports),
        data,
        owner: account.owner,
        executable: false,
      });
      await expect(expire(policy).rpc()).rejects.toThrow();

      data[8] = 1;
      context.setAccount(policy, {
        lamports: Number(account.lamports),
        data,
        owner: account.owner,
        executable: false,
      });
      // A new slot, so the retry is not the byte-identical transaction the
      // runtime already saw.
      await advanceSlots(context, 1);
      await expire(policy).rpc();
    });
  });
});
