/**
 * Declare — or refresh — the authority set that is legitimate for an agent.
 *
 * Usage:
 *   pnpm gov:declare --policy <id> --keypair keys/holder.json
 *   pnpm gov:declare --policy 7 --operator <pubkey> --operator <pubkey>
 *   pnpm gov:declare --policy 7 --upgrade-authority <pubkey> --controller <pubkey>
 *
 * Why this is a holder-signed CLI and not something the oracle does for you:
 * the whole value of the declaration is that the *policyholder* made it. A
 * baseline the operator could write would put the operator back in charge of
 * the fact that is supposed to constrain them, and a governance claim proven
 * against it would prove nothing.
 *
 * The declaration matures an hour after it lands
 * (`GOVERNANCE_BASELINE_DELAY`). Until then a claim cannot be proven against
 * it — which is deliberate, and is what forces an attacker holding a stolen
 * holder key to pre-commit on chain, in public, well before the incident.
 *
 * Refreshing keeps the previous declaration in `prev_*`, so rotating an
 * operator does not erase the record of what was legitimate yesterday.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { GOVERNANCE_BASELINE_DELAY_SECONDS, PDA_SEEDS, policyIdToBytes } from '@covantic/shared';

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

function optionalKey(args: Map<string, string[]>, name: string): PublicKey | null {
  const value = args.get(name)?.at(-1);
  return value ? new PublicKey(value) : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const policyId = args.get('policy')?.at(-1);
  if (!policyId) throw new Error('--policy <id> is required');

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
  const [baseline] = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.GOVERNANCE_BASELINE), policy.toBuffer()],
    program.programId,
  );

  const onChainPolicy = (await (
    program.account as unknown as Record<string, { fetch: (a: PublicKey) => Promise<unknown> }>
  ).insurancePolicy!.fetch(policy)) as { agentAddress: PublicKey };

  // Defaults to the agent itself, which is the ordinary case: the agent owns
  // its own token accounts and nobody else may.
  const tokenOwner = optionalKey(args, 'token-owner') ?? onChainPolicy.agentAddress;
  const extraAuthorities = (args.get('operator') ?? []).map((k) => new PublicKey(k));
  if (extraAuthorities.length > 4) {
    throw new Error('At most 4 --operator addresses (MAX_GOVERNANCE_EXTRA_AUTHORITIES)');
  }

  const manifest = {
    tokenOwner,
    expectedDelegate: optionalKey(args, 'delegate'),
    expectedCloseAuthority: optionalKey(args, 'close-authority'),
    programUpgradeAuthority: optionalKey(args, 'upgrade-authority'),
    controller: optionalKey(args, 'controller'),
    controllerMinThreshold: Number(args.get('min-threshold')?.at(-1) ?? 0),
    extraAuthorities,
    // Commits to the declaration as written. The program cannot decode a
    // Squads config or an allowed-signer list, so the richer statement lives
    // off chain and this hash is what makes it permanently falsifiable.
    manifestHash: Array.from(
      createHash('sha256')
        .update(
          JSON.stringify({
            tokenOwner: tokenOwner.toBase58(),
            operators: extraAuthorities.map((k) => k.toBase58()).sort(),
            controller: optionalKey(args, 'controller')?.toBase58() ?? null,
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
  ).declareGovernanceBaseline!(manifest)
    .accounts({
      holder: holder.publicKey,
      policy,
      baseline,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // Read it back rather than computing it — see the note in
  // `declare-agent-mandate.ts`. A `devnet-fast-lock` build compresses the
  // on-chain delay, and a locally-derived figure would tell a policyholder to
  // wait for something that has already happened.
  const onChain = (await (
    program.account as unknown as Record<
      string,
      // Structural, not `BN`: Anchor 1.x is CJS and does not export the name
      // as a type, so this file referred to one that was never in scope. Only
      // `toNumber` is read here, so that is what is required.
      { fetch: (a: PublicKey) => Promise<{ effectiveAt: { toNumber(): number } }> }
    >
  ).policyGovernanceBaseline!.fetch(baseline)) as { effectiveAt: { toNumber(): number } };
  const effectiveAt = new Date(onChain.effectiveAt.toNumber() * 1000);
  process.stdout.write(
    [
      `Declared governance baseline for policy ${policyId}`,
      `  baseline PDA : ${baseline.toBase58()}`,
      `  token owner  : ${tokenOwner.toBase58()}`,
      `  operators    : ${extraAuthorities.map((k) => k.toBase58()).join(', ') || '(none)'}`,
      `  signature    : ${signature}`,
      '',
      `Usable as proof from ${effectiveAt.toISOString()} — a claim filed before then`,
      'cannot be proven against it. That delay is the mechanism, not a formality.',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
