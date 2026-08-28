/**
 * Agent wallet CLI — generate, fund, and trigger real transactions from an
 * AI-agent keypair so the Covantic end-to-end demo runs on real on-chain
 * activity instead of synthetic webhook injections.
 *
 * Subcommands:
 *   create   --name <name>
 *              Generate a fresh Solana keypair at
 *              `keys/agents/<name>.json`, print its pubkey + the dashboard
 *              URL where the user buys a policy against it.
 *
 *   fund     --name <name> [--sol 0.5] [--usdc 5000]
 *              Airdrop SOL for fees + mint mock USDC to the agent. Uses
 *              ORACLE_KEYPAIR_PATH as the USDC mint authority.
 *
 *   trigger  --name <name> [--amount 2000] [--sink <pubkey>] [--kind transfer|arm|drain] [--kind transfer|arm|drain]
 *              Sign and broadcast real on-chain activity from the agent.
 *
 *              `--kind transfer` (default) sends an ordinary SPL-USDC transfer
 *              the agent signs itself. It raises a `large_transfer` event —
 *              recorded and alerted, but deliberately **not** a claim: without
 *              a declared mandate there is nothing to say the movement was
 *              outside what the holder expected, and filing one anyway used to
 *              park a `no_mandate_declared` review in the policy's single open
 *              claim slot forever.
 *
 *              `--kind arm` then `--kind drain` stage the covered event that
 *              needs no declaration at all. `arm` grants a foreign delegate an
 *              allowance and must run **before the policy is bought**; `drain`
 *              then moves the tokens with that delegate's signature. In the
 *              drain the account's owner is not among the signers, so the
 *              verifier resolves it as `unauthorized_movement` from the chain's
 *              own record and an exploit claim opens against the policy exactly
 *              as it was bought. Nothing is declared and nothing matures.
 *
 *              The ordering is load-bearing — see `armDelegate`.
 *
 *              Default sink = oracle keypair's ATA (always exists).
 *
 * All subcommands accept `--help` for inline usage.
 *
 * Pre-reqs:
 *   - .env configured (SOLANA_RPC_URL, ORACLE_KEYPAIR_PATH, USDC_MINT)
 *   - Oracle keypair is also the mock-USDC mint authority (see
 *     `scripts/mint-mock-usdc.ts`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  createApproveInstruction,
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import { USDC_DECIMALS } from '@covantic/shared';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const AGENTS_DIR = resolve(REPO_ROOT, 'keys/agents');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function loadKeypair(path: string): Keypair {
  const abs = path.startsWith('/') ? path : resolve(REPO_ROOT, path);
  const secret = JSON.parse(readFileSync(abs, 'utf-8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function agentKeypairPath(name: string): string {
  return resolve(AGENTS_DIR, `${name}.json`);
}

function loadAgentKeypair(name: string): Keypair {
  const path = agentKeypairPath(name);
  if (!existsSync(path)) {
    throw new Error(
      `Agent keypair '${name}' not found at ${path}\n` + `Run: pnpm agent:create --name ${name}`,
    );
  }
  return loadKeypair(path);
}

// ---------------------------------------------------------------------------
// Arg parsing — deliberately tiny; one-off CLI, no need for yargs.
// ---------------------------------------------------------------------------

interface ParsedArgs {
  subcommand: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [subcommand = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok && tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    }
  }
  return { subcommand, flags };
}

function requireFlag(flags: Record<string, unknown>, name: string): string {
  const v = flags[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Missing required --${name} flag`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdCreate(flags: Record<string, string | boolean>): Promise<void> {
  const name = requireFlag(flags, 'name');
  const path = agentKeypairPath(name);
  if (existsSync(path) && !flags.force) {
    throw new Error(
      `Agent keypair '${name}' already exists at ${path}. Pass --force to overwrite.`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  const apiPort = process.env.PORT ?? '3099';
  const webPort = apiPort === '4099' ? '3099' : '3099';
  console.log(`\nAgent created: ${name}`);
  console.log(`  Path:   ${path}`);
  console.log(`  Pubkey: ${kp.publicKey.toBase58()}`);
  console.log(`\nNext:`);
  console.log(`  1) Fund it:       pnpm agent:fund --name ${name}`);
  console.log(`  2) Buy a policy:  open http://localhost:${webPort}/dashboard`);
  console.log(`     Use this pubkey as the agent address:`);
  console.log(`        ${kp.publicKey.toBase58()}`);
  console.log(`  3) Sync Helius:   pnpm webhook:sync`);
  console.log(`  4) Trigger anomaly: pnpm agent:trigger --name ${name}`);
}

async function cmdFund(flags: Record<string, string | boolean>): Promise<void> {
  const name = requireFlag(flags, 'name');
  const agent = loadAgentKeypair(name);
  const solAmount = Number(flags.sol ?? '0.5');
  const usdcAmount = Number(flags.usdc ?? '5000');
  if (!Number.isFinite(solAmount) || solAmount <= 0) throw new Error(`Invalid --sol ${flags.sol}`);
  if (!Number.isFinite(usdcAmount) || usdcAmount <= 0)
    throw new Error(`Invalid --usdc ${flags.usdc}`);

  const rpcUrl = requireEnv('SOLANA_RPC_URL');
  const connection = new Connection(rpcUrl, 'confirmed');
  const mintAuthority = loadKeypair(requireEnv('ORACLE_KEYPAIR_PATH'));
  const mint = new PublicKey(requireEnv('USDC_MINT'));

  console.log(`\nFunding agent '${name}':`);
  console.log(`  Pubkey:       ${agent.publicKey.toBase58()}`);
  console.log(`  Mint auth:    ${mintAuthority.publicKey.toBase58()}`);
  console.log(`  USDC mint:    ${mint.toBase58()}`);

  // 1) SOL — try devnet airdrop; fall back to transfer from mint authority
  //    (airdrop is heavily rate-limited, transfer always works if the authority
  //    has SOL).
  const neededLamports = Math.round(solAmount * LAMPORTS_PER_SOL);
  const currentBalance = await connection.getBalance(agent.publicKey);
  if (currentBalance < neededLamports) {
    const delta = neededLamports - currentBalance;
    try {
      const sig = await connection.requestAirdrop(agent.publicKey, delta);
      await connection.confirmTransaction(sig, 'confirmed');
      console.log(`  SOL airdrop:  ${delta / LAMPORTS_PER_SOL} SOL via ${sig}`);
    } catch (err) {
      console.warn(
        `  SOL airdrop failed (${(err as Error).message}); falling back to transfer from mint authority`,
      );
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: mintAuthority.publicKey,
          toPubkey: agent.publicKey,
          lamports: delta,
        }),
      );
      const sig = await sendAndConfirmTransaction(connection, tx, [mintAuthority]);
      console.log(`  SOL transfer: ${delta / LAMPORTS_PER_SOL} SOL via ${sig}`);
    }
  } else {
    console.log(`  SOL balance:  ${currentBalance / LAMPORTS_PER_SOL} SOL (already funded)`);
  }

  // 2) USDC — mint directly to agent's ATA
  const agentAta = await getOrCreateAssociatedTokenAccount(
    connection,
    mintAuthority,
    mint,
    agent.publicKey,
  );
  const rawAmount = BigInt(Math.round(usdcAmount * 10 ** USDC_DECIMALS));
  const mintSig = await mintTo(
    connection,
    mintAuthority,
    mint,
    agentAta.address,
    mintAuthority,
    rawAmount,
  );
  console.log(`  USDC ATA:     ${agentAta.address.toBase58()}`);
  console.log(`  USDC mint:    ${usdcAmount} USDC via ${mintSig}`);
  console.log(`\nAgent is funded and ready to transact.`);
}

async function cmdTrigger(flags: Record<string, string | boolean>): Promise<void> {
  const name = requireFlag(flags, 'name');
  const agent = loadAgentKeypair(name);
  const amountUi = Number(flags.amount ?? '2000');
  if (!Number.isFinite(amountUi) || amountUi <= 0)
    throw new Error(`Invalid --amount ${flags.amount}`);

  const rpcUrl = requireEnv('SOLANA_RPC_URL');
  const connection = new Connection(rpcUrl, 'confirmed');
  const mintAuthority = loadKeypair(requireEnv('ORACLE_KEYPAIR_PATH'));
  const mint = new PublicKey(requireEnv('USDC_MINT'));

  // Default sink = oracle ATA (always exists since the authority owns the mint).
  const sinkPubkey = flags.sink ? new PublicKey(String(flags.sink)) : mintAuthority.publicKey;
  const sourceAta = await getOrCreateAssociatedTokenAccount(
    connection,
    mintAuthority,
    mint,
    agent.publicKey,
  );
  const sinkAta = await getOrCreateAssociatedTokenAccount(
    connection,
    mintAuthority,
    mint,
    sinkPubkey,
  );

  const rawAmount = BigInt(Math.round(amountUi * 10 ** USDC_DECIMALS));
  const kind = String(flags.kind ?? 'transfer');
  if (kind !== 'transfer' && kind !== 'arm' && kind !== 'drain') {
    throw new Error(`Invalid --kind ${kind} (expected 'transfer', 'arm' or 'drain')`);
  }

  if (kind === 'arm') {
    await armDelegate({
      connection,
      agent,
      name,
      feePayer: mintAuthority,
      sourceAta: sourceAta.address,
      rawAmount,
      amountUi,
    });
    return;
  }

  if (kind === 'drain') {
    await drainAsDelegate({
      connection,
      agent,
      name,
      feePayer: mintAuthority,
      sourceAta: sourceAta.address,
      sinkAta: sinkAta.address,
      sinkOwner: sinkPubkey,
      amountUi,
      rawAmount,
    });
    return;
  }

  console.log(`\nTriggering anomaly from agent '${name}':`);
  console.log(`  From:   ${agent.publicKey.toBase58()}`);
  console.log(`  To:     ${sinkPubkey.toBase58()}`);
  console.log(`  Amount: ${amountUi} USDC (raw ${rawAmount.toString()})`);
  if (amountUi <= 1000) {
    console.log(`  ⚠ WARNING: ${amountUi} USDC is below the 1,000 USDC LARGE threshold.`);
    console.log(`    The TransactionMonitor will NOT flag this as an anomaly.`);
  }

  const tx = new Transaction().add(
    createTransferInstruction(sourceAta.address, sinkAta.address, agent.publicKey, rawAmount),
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [agent]);

  const network = process.env.SOLANA_NETWORK ?? 'devnet';
  console.log(`\n✓ Broadcast real tx: ${sig}`);
  console.log(`  https://explorer.solana.com/tx/${sig}?cluster=${network}`);
  console.log(`\nIf Helius is wired (pnpm webhook:sync), a claim should appear in`);
  console.log(`the API + dashboard within ~10 seconds.`);
}

/** Where `arm` parks the delegate so `drain` can find it again. */
function delegateKeypairPath(name: string): string {
  return resolve(AGENTS_DIR, `${name}.delegate.json`);
}

/**
 * Grant a foreign delegate authority over the agent's covered account.
 *
 * Run this **before the policy is bought**, and the ordering is the whole
 * reason the step exists separately.
 *
 * An `Approve` is a change of control, and the authority checkpoint is right
 * to read it as one: run against a live policy it raises
 * `foreign_delegate_authority` and opens a *governance* claim, which needs a
 * baseline the holder declared and therefore resolves to review. Worse, it
 * takes the policy's single open-claim slot, so the drain that follows can no
 * longer open the exploit claim it should have.
 *
 * Arming first avoids all of that without weakening anything. The delegate is
 * simply part of the picture the first checkpoint records, so nothing changed
 * hands while the policy was live, and the drain is judged on the only
 * question that matters for it: whether the account's owner signed.
 */
async function armDelegate(opts: {
  connection: Connection;
  agent: Keypair;
  name: string;
  feePayer: Keypair;
  sourceAta: PublicKey;
  rawAmount: bigint;
  amountUi: number;
}): Promise<void> {
  const { connection, agent, name, feePayer, sourceAta, rawAmount, amountUi } = opts;
  const delegate = Keypair.generate();
  const path = delegateKeypairPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(delegate.secretKey)));

  const tx = new Transaction().add(
    createApproveInstruction(sourceAta, delegate.publicKey, agent.publicKey, rawAmount),
  );
  tx.feePayer = feePayer.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [feePayer, agent]);
  const network = process.env.SOLANA_NETWORK ?? 'devnet';

  console.log(`\nArmed agent '${name}':`);
  console.log(`  Delegate:  ${delegate.publicKey.toBase58()}`);
  console.log(`  Allowance: ${amountUi} USDC`);
  console.log(`  Saved to:  ${path}`);
  console.log(`\n✓ approve ${sig}`);
  console.log(`  https://explorer.solana.com/tx/${sig}?cluster=${network}`);
  console.log(`\nNow buy the policy in the UI, wait ~2 minutes for the first`);
  console.log(`checkpoint, then: pnpm agent:trigger --name ${name} --kind drain`);
}

/**
 * Move the agent's tokens with the delegate's signature and not the agent's.
 *
 * This is the covered event in its simplest honest form. The account's owner
 * is not among the transaction's signers, which the exploit verifier reads
 * straight off the chain record — no declaration by the holder is involved,
 * and none is needed, because nothing here depends on what anyone intended.
 */
async function drainAsDelegate(opts: {
  connection: Connection;
  agent: Keypair;
  name: string;
  feePayer: Keypair;
  sourceAta: PublicKey;
  sinkAta: PublicKey;
  sinkOwner: PublicKey;
  amountUi: number;
  rawAmount: bigint;
}): Promise<void> {
  const { connection, name, feePayer, sourceAta, sinkAta, sinkOwner, amountUi, rawAmount } = opts;
  const path = delegateKeypairPath(name);
  if (!existsSync(path)) {
    throw new Error(
      `No delegate for '${name}'. Run \`pnpm agent:trigger --name ${name} --kind arm\` ` +
        `before buying the policy.`,
    );
  }
  const delegate = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, 'utf-8')) as number[]),
  );

  const tx = new Transaction().add(
    createTransferInstruction(sourceAta, sinkAta, delegate.publicKey, rawAmount),
  );
  tx.feePayer = feePayer.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [feePayer, delegate]);
  const network = process.env.SOLANA_NETWORK ?? 'devnet';

  console.log(`\nDraining agent '${name}' as its delegate:`);
  console.log(`  Delegate: ${delegate.publicKey.toBase58()}`);
  console.log(`  Sink:     ${sinkOwner.toBase58()}`);
  console.log(`  Amount:   ${amountUi} USDC (raw ${rawAmount.toString()})`);
  console.log(`\n✓ drain ${sig}`);
  console.log(`  https://explorer.solana.com/tx/${sig}?cluster=${network}`);
  console.log(`\nThe agent signed nothing here. Expect an exploit claim within`);
  console.log(`~10s (webhook) or ~2min (watcher sweep).`);
}

function printHelp(): void {
  console.log(`Usage: pnpm agent:<subcommand> [flags]

Subcommands:
  create   --name <name> [--force]
  fund     --name <name> [--sol 0.5] [--usdc 5000]
  trigger  --name <name> [--amount 2000] [--sink <pubkey>]

Examples:
  pnpm agent:create --name rogue-trader
  pnpm agent:fund --name rogue-trader
  pnpm agent:trigger --name rogue-trader --amount 2500
  pnpm agent:trigger --name rogue-trader --kind arm     # BEFORE buying the policy
  pnpm agent:trigger --name rogue-trader --kind drain   # opens an exploit claim

Full runbook:
  1) Create a fresh agent keypair          pnpm agent:create --name <n>
  2) Fund it (SOL + mock USDC)             pnpm agent:fund --name <n>
  3) Buy a policy via /dashboard against the agent's pubkey
  4) Expose the API publicly               ngrok http 4099
     then export WEBHOOK_PUBLIC_URL        https://<tunnel-host>
  5) Sync the Helius webhook               pnpm webhook:sync
  6) Send a real >1,000 USDC transfer      pnpm agent:trigger --name <n>
  7) Watch /claims — the anomaly arrives from Helius within ~10s, the
     claim is auto-verified on-chain, and the payout settles after the
     lock period (~1h for exploit/oracle, 6h for agent_error).
`);
}

async function main() {
  const { subcommand, flags } = parseArgs(process.argv.slice(2));

  if (flags.help || subcommand === 'help') {
    printHelp();
    return;
  }

  switch (subcommand) {
    case 'create':
      await cmdCreate(flags);
      return;
    case 'fund':
      await cmdFund(flags);
      return;
    case 'trigger':
      await cmdTrigger(flags);
      return;
    default:
      console.error(`Unknown subcommand: ${subcommand}\n`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
