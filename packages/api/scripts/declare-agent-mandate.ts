/**
 * Declare — or refresh — the operating envelope that is legitimate for an
 * agent.
 *
 * Usage:
 *   pnpm mandate:declare --policy <id> --max-single 1000 --keypair keys/holder.json
 *   pnpm mandate:declare --policy 7 --max-single 1000 --max-window 5000 --window 3600
 *   pnpm mandate:declare --policy 7 --max-single 1000 --min-retained 500 \
 *                        --counterparty <pubkey> --program <pubkey>
 *
 * Why this is a holder-signed CLI and not something the oracle does for you:
 * the whole value of the declaration is that the *policyholder* made it. An
 * envelope the operator could write would put the operator back in charge of
 * the fact that is supposed to constrain them, and an agent-error claim proven
 * against it would prove nothing.
 *
 * Why the declaration exists at all: an agent error is a loss the agent caused
 * with its *own* authority, so there is no unauthorised signer to point at and
 * no change of control to observe. Every forensic trace says the agent meant
 * it, because it did. What separates a mistake from a decision is what the
 * holder expected — and that is not a fact about the transaction. Declaring it
 * in advance is what turns "was this a mistake?" into a comparison of numbers.
 *
 * The declaration matures an hour after it lands
 * (`MANDATE_DECLARATION_DELAY`). Until then a claim cannot be proven against
 * it — deliberately, because otherwise a holder could watch an ordinary loss
 * happen and then declare an envelope narrow enough to have been breached by
 * it.
 *
 * Refreshing keeps the previous declaration in `prev_*`, so tightening a cap
 * does not erase the record of what was permitted yesterday.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

import anchorPkg, { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';

// Anchor 1.x ships CommonJS with no named `BN` export, so `import { BN }`
// throws at module load — before any argument is parsed, which is why this
// looked like a broken CLI rather than a dependency change. The rest of the
// scripts already reach it through the default export.
const { BN } = anchorPkg;
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  MANDATE_DECLARATION_DELAY_SECONDS,
  MAX_MANDATE_COUNTERPARTIES,
  MAX_MANDATE_PROGRAMS,
  PDA_SEEDS,
  USDC_DECIMALS,
  policyIdToBytes,
} from '@covantic/shared';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function loadKeypair(path: string): Keypair {
  const abs = path.startsWith('/') ? path : resolve(REPO_ROOT, path);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(abs, 'utf-8')) as number[]));
}

/** Collect repeated `--flag value` pairs; single-valued flags take the last. */
function parseArgs(argv: string[]): Map<string, string[]> {
  const args = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) continue;
    args.set(key, [...(args.get(key) ?? []), value]);
    i += 1;
  }
  return args;
}

/** UI USDC → base units. The mandate is denominated in the covered mint. */
function usdc(value: string | undefined, fallback = 0): BN {
  if (value === undefined) return new BN(fallback);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Not a USDC amount: ${value}`);
  return new BN(Math.round(parsed * 10 ** USDC_DECIMALS));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const policyId = args.get('policy')?.at(-1);
  if (!policyId) throw new Error('--policy <id> is required');

  const maxSingle = args.get('max-single')?.at(-1);
  if (!maxSingle) {
    throw new Error(
      '--max-single <usdc> is required: an envelope with no cap is not a declaration, and ' +
        'the program refuses a zero cap because it would make every movement a breach.',
    );
  }

  const keypairPath = args.get('keypair')?.at(-1) ?? requireEnv('ORACLE_KEYPAIR_PATH');
  const holder = loadKeypair(keypairPath);

  const connection = new Connection(requireEnv('SOLANA_RPC_URL'), 'confirmed');
  const provider = new AnchorProvider(connection, new Wallet(holder), {
    commitment: 'confirmed',
  });
  const idl = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'packages/anchor/target/idl/covantic.json'), 'utf-8'),
  ) as Idl;
  const program = new Program(idl, provider);

  const [policy] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(PDA_SEEDS.POLICY),
      holder.publicKey.toBuffer(),
      Buffer.from(policyIdToBytes(BigInt(policyId))),
    ],
    program.programId,
  );
  const [mandatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.AGENT_MANDATE), policy.toBuffer()],
    program.programId,
  );
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.CONFIG)],
    program.programId,
  );

  // Anchor cannot resolve `covered_token_account` on its own: it is an ATA of
  // the *policy's* agent, and reaching that means fetching the policy, then
  // the config for the mint, then deriving — three hops past the resolver's
  // depth limit, which it reports as `Reached maximum depth for account
  // resolution` with no hint that the account was derivable all along.
  const usdcMint = new PublicKey(requireEnv('USDC_MINT'));
  const policyAccount = (await (
    program.account as unknown as Record<
      string,
      { fetch: (a: PublicKey) => Promise<{ agentAddress: PublicKey }> }
    >
  ).insurancePolicy!.fetch(policy)) as { agentAddress: PublicKey };
  // `allowOwnerOffCurve` is false deliberately: the covered account is the
  // agent wallet's own ATA, and the program derives it the same way.
  const coveredTokenAccount = getAssociatedTokenAddressSync(usdcMint, policyAccount.agentAddress);

  const maxSingleOutflow = usdc(maxSingle);
  // Defaults to the single cap: a window bound below one permitted movement
  // contradicts itself, and the program rejects it.
  const maxWindowOutflow = args.get('max-window')?.at(-1)
    ? usdc(args.get('max-window')?.at(-1))
    : maxSingleOutflow;
  const windowSeconds = new BN(Number(args.get('window')?.at(-1) ?? 3_600));
  const minRetainedBalance = usdc(args.get('min-retained')?.at(-1), 0);

  const allowedCounterparties = (args.get('counterparty') ?? []).map((k) => new PublicKey(k));
  const allowedPrograms = (args.get('program') ?? []).map((k) => new PublicKey(k));
  if (allowedCounterparties.length > MAX_MANDATE_COUNTERPARTIES) {
    throw new Error(`At most ${MAX_MANDATE_COUNTERPARTIES} --counterparty addresses`);
  }
  if (allowedPrograms.length > MAX_MANDATE_PROGRAMS) {
    throw new Error(`At most ${MAX_MANDATE_PROGRAMS} --program addresses`);
  }

  const mandate = {
    maxSingleOutflow,
    maxWindowOutflow,
    windowSeconds,
    minRetainedBalance,
    allowedCounterparties,
    allowedPrograms,
    // Commits to the declaration as written. The program enforces only the two
    // amount bounds it can re-derive from a balance it reads; everything
    // richer — per-venue caps, slippage bounds — lives off chain, and this
    // hash is what makes it permanently falsifiable.
    manifestHash: Array.from(
      createHash('sha256')
        .update(
          JSON.stringify({
            maxSingleOutflow: maxSingleOutflow.toString(),
            maxWindowOutflow: maxWindowOutflow.toString(),
            windowSeconds: windowSeconds.toString(),
            minRetainedBalance: minRetainedBalance.toString(),
            counterparties: allowedCounterparties.map((k) => k.toBase58()).sort(),
            programs: allowedPrograms.map((k) => k.toBase58()).sort(),
          }),
        )
        .digest(),
    ),
  };

  const signature = await (
    program.methods as unknown as Record<
      string,
      (m: unknown) => {
        accounts: (a: Record<string, PublicKey>) => { rpc: () => Promise<string> };
      }
    >
  ).declareAgentMandate!(mandate)
    .accounts({
      holder: holder.publicKey,
      policy,
      mandate: mandatePda,
      config: configPda,
      coveredTokenAccount,
      usdcMint,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const effectiveAt = new Date(Date.now() + MANDATE_DECLARATION_DELAY_SECONDS * 1000);
  const ui = (v: BN) => (Number(v.toString()) / 10 ** USDC_DECIMALS).toLocaleString();

  process.stdout.write(
    [
      `Declared agent mandate for policy ${policyId}`,
      `  mandate PDA    : ${mandatePda.toBase58()}`,
      `  max single     : ${ui(maxSingleOutflow)} USDC   (checked on chain)`,
      `  max per window : ${ui(maxWindowOutflow)} USDC over ${windowSeconds.toString()}s`,
      `  min retained   : ${ui(minRetainedBalance)} USDC   (checked on chain)`,
      `  counterparties : ${allowedCounterparties.map((k) => k.toBase58()).join(', ') || '(undeclared — silence, not prohibition)'}`,
      `  programs       : ${allowedPrograms.map((k) => k.toBase58()).join(', ') || '(undeclared — silence, not prohibition)'}`,
      `  signature      : ${signature}`,
      '',
      `Usable as proof from ${effectiveAt.toISOString()} — a claim filed before then`,
      'cannot be proven against it. That delay is the mechanism, not a formality.',
      '',
      'What this covers: a movement that exceeds the caps above, or takes the covered',
      'account below the retained floor. What it does not: a loss inside the envelope.',
      'Declaring a wide envelope means fewer claims; a narrow one means the vault pays',
      'only what exceeds it, since the first slice of any breach is risk you declared',
      'you were willing to run.',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
