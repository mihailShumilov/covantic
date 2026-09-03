/**
 * Bootstrap the agent fleet.
 *
 * Creates N fresh agent keypairs (or tops up to N if a fleet already
 * exists), funds them with SOL + mock USDC, triggers a risk score + quote
 * via the running API, and buys a policy on-chain for each one with the
 * fleet-holder keypair signing.
 *
 * Writes the manifest to `keys/fleet.json` so `fleet:start` can load it
 * without re-discovering anything.
 *
 * Usage:
 *   pnpm fleet:bootstrap                    # target size 3 (default)
 *   pnpm fleet:bootstrap --count 5
 *   pnpm fleet:bootstrap --count 5 --coverage 200 --duration 86400
 *   pnpm fleet:bootstrap --count 6 --fund 700 --cap 650 --coverage 200
 *              A deliberately tight envelope, for a policy meant to be
 *              breached. The flat premium is `fund - cap`.
 *
 * Pre-reqs:
 *   - API running at $API_URL (default http://localhost:4099) with risk +
 *     quote endpoints wired. The quote endpoint is what publishes the
 *     oracle-signed RiskAttestation PDA that createPolicy reads on chain.
 *   - Oracle keypair is the USDC mint authority (same as mint-mock-usdc.ts).
 *   - Anchor IDL built (packages/anchor/target/idl/covantic.json).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

import anchorPkg, { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import { PDA_SEEDS, policyIdToBytes } from '@covantic/shared';

import { loadManifest, saveManifest, appendAgent } from '../src/services/fleet/manifest.js';
import type { FleetAgent, FleetManifest } from '../src/services/fleet/types.js';
import { rpcEndpointName } from '../src/config/rpc-pool.js';

const { BN } = anchorPkg;


/**
 * The envelope the fleet's policies are bought against.
 *
 * Wide enough that ordinary fleet activity never touches it — these agents
 * exist to produce real on-chain traffic, not to breach anything — and
 * declared at purchase because there is no longer anywhere else to declare it.
 * The premium is quoted against this, so a fleet bought with a tight envelope
 * would be paying for a deductible it has no use for.
 */
export const FLEET_ENVELOPE = {
  maxSingleOutflowRaw: 1_000_000_000_000,
  maxWindowOutflowRaw: 1_000_000_000_000,
  windowSeconds: 3_600,
  minRetainedBalanceRaw: 0,
  allowedCounterparties: [] as string[],
  allowedPrograms: [] as string[],
};

/**
 * A tighter envelope, for a policy meant to be breached on purpose.
 *
 * `--cap` narrows it; `--fund` sets what the agent holds. The two together
 * decide the price, and the relationship is the whole point of the pricing
 * change: the flat premium is what the holder could extract at will, which is
 * `balance - cap`. A 700 USDC agent under a 650 cap costs 50 and can be walked
 * over for 50. Widen the gap and the policy costs more, in exact step.
 */
function envelopeFrom(capUsdc: number | null, floorUsdc: number): typeof FLEET_ENVELOPE {
  if (capUsdc === null) return FLEET_ENVELOPE;
  return {
    maxSingleOutflowRaw: Math.round(capUsdc * 1_000_000),
    maxWindowOutflowRaw: Math.round(capUsdc * 1_000_000),
    windowSeconds: 3_600,
    minRetainedBalanceRaw: Math.round(floorUsdc * 1_000_000),
    // Declared, not left blank, and the difference is 0.06 of the confidence a
    // payout needs. A silent allowlist is reported `unevaluated` — correctly,
    // since silence is not prohibition — and each unevaluated dimension costs
    // 0.03. Two of them put an otherwise perfect verdict under the review bar.
    //
    // These are the destination `agent:trigger` actually sends to and the
    // program it goes through, so both checks run and both pass.
    allowedCounterparties: [DEMO_SINK_OWNER],
    allowedPrograms: [TOKEN_PROGRAM_ID.toBase58()],
  };
}

/** Where `agent:trigger` sends by default: the mint authority's own wallet. */
const DEMO_SINK_OWNER = '8SUV2eNzyrWfyZod1StCSuyBBTk5jruFydaMe8yRyLVC';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const AGENTS_DIR = resolve(REPO_ROOT, 'keys/agents');
const HOLDER_KEYPAIR_PATH = resolve(REPO_ROOT, 'keys/fleet-holder.json');

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

function ensureKeypair(path: string): Keypair {
  if (existsSync(path)) return loadKeypair(path);
  mkdirSync(dirname(path), { recursive: true });
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`  Generated new keypair at ${path} (pubkey ${kp.publicKey.toBase58()})`);
  return kp;
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok?.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = 'true';
      }
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Program loading — doesn't depend on demo-common.ts so this stays runnable
// against a fresh clone where demo deps might not be built yet.
// ---------------------------------------------------------------------------

function loadIdl(): Idl {
  const candidates = [
    resolve(REPO_ROOT, 'packages/anchor/target/idl/covantic.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as Idl;
    } catch {
      // try next
    }
  }
  throw new Error('Covantic IDL not found. Run `anchor build` in packages/anchor first.');
}

function makeProgram(connection: Connection, signer: Keypair) {
  const wallet = new Wallet(signer);
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const idl = loadIdl();
  const program = new Program(idl, provider);
  return { program, provider };
}

// ---------------------------------------------------------------------------
// Funding helpers
// ---------------------------------------------------------------------------

async function ensureSol(
  connection: Connection,
  mintAuthority: Keypair,
  to: PublicKey,
  targetSol: number,
): Promise<void> {
  const needed = Math.round(targetSol * LAMPORTS_PER_SOL);
  const current = await connection.getBalance(to);
  if (current >= needed) return;
  const delta = needed - current;
  try {
    const sig = await connection.requestAirdrop(to, delta);
    await connection.confirmTransaction(sig, 'confirmed');
  } catch {
    // Airdrop rate-limited — fall back to transfer from mint authority.
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: mintAuthority.publicKey,
        toPubkey: to,
        lamports: delta,
      }),
    );
    await sendAndConfirmTransaction(connection, tx, [mintAuthority]);
  }
}

async function ensureUsdc(
  connection: Connection,
  mintAuthority: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  targetUi: number,
): Promise<void> {
  const ata = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, mint, owner);
  const info = await connection.getTokenAccountBalance(ata.address);
  const currentUi = Number(info.value.uiAmount ?? 0);
  if (currentUi >= targetUi) return;
  const delta = targetUi - currentUi;
  const raw = BigInt(Math.round(delta * 10 ** 6));
  await mintTo(connection, mintAuthority, mint, ata.address, mintAuthority, raw);
}

// ---------------------------------------------------------------------------
// API integration — uses the running API for risk scoring + attestation.
// ---------------------------------------------------------------------------

interface QuoteResponse {
  agentAddress: string;
  riskTier: number;
  premiumBps: number;
  premiumAmount: number;
  coverageAmount: number;
  durationSeconds: number;
  attestationPda?: string | null;
  attestationExpiresAt?: string | null;
}

async function fetchRiskAndQuote(
  apiUrl: string,
  agentAddress: string,
  coverageRaw: number,
  durationSeconds: number,
  envelope: typeof FLEET_ENVELOPE,
): Promise<QuoteResponse> {
  // 1. Trigger / refresh the risk score.
  const riskRes = await fetch(`${apiUrl}/api/risk/${encodeURIComponent(agentAddress)}`);
  if (!riskRes.ok) {
    throw new Error(
      `GET /api/risk failed: HTTP ${riskRes.status} ${await riskRes.text()}`,
    );
  }

  // 2. Ask for a quote — this is what calls attestationPublisher.ensureFresh.
  const quoteRes = await fetch(`${apiUrl}/api/policies/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentAddress,
      coverageAmount: coverageRaw,
      durationSeconds,
      // The quote prices this envelope and the oracle commits to its hash;
      // `create_policy` refuses a purchase that declares a different one.
      mandate: envelope,
    }),
  });
  if (!quoteRes.ok) {
    throw new Error(
      `POST /api/policies/quote failed: HTTP ${quoteRes.status} ${await quoteRes.text()}`,
    );
  }
  return (await quoteRes.json()) as QuoteResponse;
}

// ---------------------------------------------------------------------------
// On-chain createPolicy
// ---------------------------------------------------------------------------

async function buyPolicy(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any>,
  connection: Connection,
  holder: Keypair,
  agentPubkey: PublicKey,
  usdcMint: PublicKey,
  coverageRaw: number,
  durationSeconds: number,
  envelope: typeof FLEET_ENVELOPE,
): Promise<{ policyId: number; signature: string }> {
  const programId = program.programId;

  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.CONFIG)],
    programId,
  )[0];
  const vaultPda = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.VAULT)],
    programId,
  )[0];
  const attestationPda = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.ATTESTATION), agentPubkey.toBuffer()],
    programId,
  )[0];

  // Read policy_counter off-chain so we can derive the policy PDA.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = (await (program.account as any).protocolConfig.fetch(configPda)) as {
    policyCounter: anchorPkg.BN;
    usdcMint: PublicKey;
  };
  const policyIdBN: anchorPkg.BN = cfg.policyCounter;
  const policyId = Number(policyIdBN.toString());
  const policyPda = PublicKey.findProgramAddressSync(
    [
      Buffer.from(PDA_SEEDS.POLICY),
      holder.publicKey.toBuffer(),
      Buffer.from(policyIdToBytes(BigInt(policyId))),
    ],
    programId,
  )[0];

  const holderAta = getAssociatedTokenAddressSync(usdcMint, holder.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);

  const signature = await program.methods
    .createPolicy(new BN(coverageRaw), new BN(durationSeconds), agentPubkey, {
      maxSingleOutflow: new BN(envelope.maxSingleOutflowRaw),
      maxWindowOutflow: new BN(envelope.maxWindowOutflowRaw),
      windowSeconds: new BN(envelope.windowSeconds),
      minRetainedBalance: new BN(envelope.minRetainedBalanceRaw),
      // From the envelope, not empty. The quote committed to *these* keys, and
      // `create_policy` recomputes the hash from what it is handed — passing
      // empty arrays here is the mismatch the check exists to catch, and it
      // caught it.
      allowedCounterparties: envelope.allowedCounterparties.map((k) => new PublicKey(k)),
      allowedPrograms: envelope.allowedPrograms.map((k) => new PublicKey(k)),
      manifestHash: Array.from(new Uint8Array(32)),
    })
    .accounts({
      holder: holder.publicKey,
      config: configPda,
      vault: vaultPda,
      attestation: attestationPda,
      policy: policyPda,
      mandate: PublicKey.findProgramAddressSync(
        [Buffer.from(PDA_SEEDS.AGENT_MANDATE), policyPda.toBuffer()],
        program.programId,
      )[0],
      coveredTokenAccount: getAssociatedTokenAddressSync(usdcMint, agentPubkey),
      usdcMint,
      holderTokenAccount: holderAta,
      vaultTokenAccount: vaultAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([holder])
    .rpc({ commitment: 'confirmed' });

  await connection.confirmTransaction(signature, 'confirmed');
  return { policyId, signature };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('fleet-bootstrap refuses to run with NODE_ENV=production');
  }
  const flags = parseFlags(process.argv.slice(2));
  const targetCount = Math.max(1, Math.min(20, Number(flags.count ?? '3')));
  // `--cap` buys a deliberately tight envelope, for a policy meant to be
  // breached. `--fund` sets what the agent holds, and the two together decide
  // the price: the flat premium is `balance - cap`, the amount a holder could
  // walk the agent over the line for.
  const capUsdc = flags.cap === undefined ? null : Number(flags.cap);
  const floorUsdc = Number(flags.floor ?? '0');
  const envelope = envelopeFrom(capUsdc, floorUsdc);
  const fundUsdc = Number(flags.fund ?? '5000');
  const coverageUi = Number(flags.coverage ?? '100'); // USDC
  const coverageRaw = Math.round(coverageUi * 10 ** 6);
  const durationSeconds = Number(flags.duration ?? `${3 * 24 * 60 * 60}`); // 3 days

  const apiUrl = process.env.API_URL ?? 'http://localhost:4099';
  const rpcUrl = requireEnv('SOLANA_RPC_URL');
  const usdcMint = new PublicKey(requireEnv('USDC_MINT'));
  const connection = new Connection(rpcUrl, 'confirmed');
  // The mint authority is deliberately NOT the oracle key any more. The oracle
  // is a hot key living in three containers; the mint authority can mint the
  // covered asset, so it belongs with the cold admin key. Falls back to
  // ORACLE_KEYPAIR_PATH so a deployment that has not split them still works.
  const mintAuthority = loadKeypair(
    process.env.MINT_AUTHORITY_KEYPAIR_PATH ?? requireEnv('ORACLE_KEYPAIR_PATH'),
  );

  console.log('\n=== fleet:bootstrap ===');
  console.log(`  target count:     ${targetCount}`);
  console.log(`  coverage/agent:   ${coverageUi} USDC`);
  console.log(`  duration/agent:   ${Math.round(durationSeconds / 3600)} h`);
  console.log(`  api:              ${apiUrl}`);
  console.log(`  rpc:              ${rpcEndpointName(rpcUrl)}`);
  console.log(`  usdc mint:        ${usdcMint.toBase58()}`);

  // 1. Holder
  const holder = ensureKeypair(HOLDER_KEYPAIR_PATH);
  console.log(`\nFleet holder: ${holder.publicKey.toBase58()}`);
  await ensureSol(connection, mintAuthority, holder.publicKey, 0.5);
  // Budget: the risk tier is no longer what a premium is made of.
  //
  // The tier half is small and bounded — LOW at 100 USDC / 3d is about 0.08,
  // HIGH about 0.4 — and a flat 100 USDC covered a fleet of twenty. The
  // envelope half is not bounded by anything so convenient: it is what the
  // holder could walk the agent over the line for, `balance - cap`, so a
  // deliberately tight demo envelope costs hundreds and the old budget bought
  // nothing at all. `insufficient funds` from the token program, from inside
  // `create_policy`, with the premium transfer as the only clue.
  //
  // `ensureUsdc` tops up to a target, so sizing this for the whole fleet costs
  // one mint of the shortfall.
  const envelopePremium =
    capUsdc === null ? 0 : Math.min(coverageUi, Math.max(0, fundUsdc - capUsdc));
  const holderBudget = targetCount * (envelopePremium + 5) + 100;
  await ensureUsdc(connection, mintAuthority, usdcMint, holder.publicKey, holderBudget);
  console.log('  SOL + USDC funded for holder.');

  // 2. Load existing manifest
  let manifest: FleetManifest = loadManifest();
  if (manifest.holderKeypairPath !== 'keys/fleet-holder.json') {
    manifest = { ...manifest, holderKeypairPath: 'keys/fleet-holder.json' };
  }
  const existingCount = manifest.agents.length;

  // Buying cover for an agent that already exists, rather than making another.
  //
  // Every failed run used to leave a funded agent behind with no policy on it,
  // and the fleet is capped at twenty — so a few bad runs filled it with
  // agents nothing could be bought for, and the next `demo:arm` reported
  // "already at target size" and stopped. Naming one reuses what is already
  // funded instead of growing the fleet to work around it.
  const reuseName = flags.agent;
  const targets: Array<{ name: string; isNew: boolean }> = reuseName
    ? [{ name: reuseName, isNew: false }]
    : Array.from({ length: Math.max(0, targetCount - existingCount) }, (_, i) => ({
        name: `fleet-${Date.now().toString(36)}-${existingCount + i}`,
        isNew: true,
      }));

  if (reuseName) {
    console.log(`\nExisting fleet: ${existingCount} agents. Buying cover for ${reuseName}.`);
    if (!existsSync(resolve(AGENTS_DIR, `${reuseName}.json`))) {
      throw new Error(`No such agent: ${reuseName}. \`pnpm agent:create --name <name>\` first.`);
    }
  } else {
    console.log(`\nExisting fleet: ${existingCount} agents. Creating ${targets.length} new.`);
  }

  if (targets.length === 0) {
    console.log('Fleet is already at or above the target size.');
    console.log('Buy cover for one that has none: --agent <name>.');
    saveManifest(manifest);
    return;
  }

  // 3. Program (holder signs)
  const { program } = makeProgram(connection, holder);

  // 4. Provision each target
  for (const target of targets) {
    const { name } = target;
    const keypairPath = resolve(AGENTS_DIR, `${name}.json`);
    const agent = ensureKeypair(keypairPath);
    const agentPubkey = agent.publicKey;

    console.log(`\n→ ${name} (${agentPubkey.toBase58()})`);

    // Fund: SOL for fees, USDC for activity. The USDC figure is not cosmetic
    // once an envelope is declared — the flat premium is `balance - cap`, so
    // funding an agent above its own cap is what the policy charges for.
    await ensureSol(connection, mintAuthority, agentPubkey, 0.1);
    await ensureUsdc(connection, mintAuthority, usdcMint, agentPubkey, fundUsdc);
    console.log(`  funded: 0.1 SOL + ${fundUsdc} USDC`);

    // Score + quote (also publishes attestation).
    const quote = await fetchRiskAndQuote(
      apiUrl,
      agentPubkey.toBase58(),
      coverageRaw,
      durationSeconds,
      envelope,
    );
    console.log(
      `  risk:  tier=${quote.riskTier} premium=${quote.premiumAmount} raw (≈ ${(
        quote.premiumAmount / 10 ** 6
      ).toFixed(4)} USDC)`,
    );

    // Buy policy (holder signs).
    const { policyId, signature } = await buyPolicy(
      program,
      connection,
      holder,
      agentPubkey,
      usdcMint,
      coverageRaw,
      durationSeconds,
      envelope,
    );
    console.log(`  policy #${policyId} bought: ${signature}`);

    const row: FleetAgent = {
      name,
      pubkey: agentPubkey.toBase58(),
      holderPubkey: holder.publicKey.toBase58(),
      policyId,
      coverageAmountRaw: coverageRaw,
      riskTier: quote.riskTier,
      durationSeconds,
      createdAt: new Date().toISOString(),
    };
    manifest = target.isNew
      ? appendAgent(manifest, row)
      : {
          ...manifest,
          agents: manifest.agents.map((a) => (a.name === name ? row : a)),
        };
    saveManifest(manifest);
  }

  console.log('\n✓ Fleet bootstrap complete.\n');
  console.log('Next:');
  console.log('  1) Sync Helius webhook          pnpm webhook:sync');
  console.log('  2) Start the runner             pnpm fleet:start');
  console.log('  3) Watch the live feed          open http://localhost:3099/claims\n');
}

main().catch((err) => {
  console.error('\n✗ fleet:bootstrap failed:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
