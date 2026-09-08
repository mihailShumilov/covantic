/**
 * Declare — or refresh — the authority set that is legitimate for an agent.
 *
 * Usage:
 *   pnpm gov:declare --policy <id> --keypair keys/holder.json
 *   pnpm gov:declare --policy 7 --operator <pubkey> --operator <pubkey>
 *   pnpm gov:declare --policy 7 --delegate <pubkey> --close-authority <pubkey>
 *   pnpm gov:declare --policy 7 --extension-hash <64 hex chars>
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
 * The program reads the covered account while declaring and refuses a
 * declaration the account does not currently satisfy: the owner, any
 * delegate and any close authority must all be inside the declared set. A
 * declaration is a statement about the account as it stands, not a story.
 *
 * Refreshing keeps the whole previous declaration in `prev_*`, so rotating an
 * operator does not erase the record of what was legitimate yesterday.
 *
 * Program upgrade authorities and multisig controllers are not accepted: the
 * checkpoint reads a token account and cannot observe either, so the program
 * refuses to present them as covered. `--upgrade-authority`,
 * `--controller` and `--min-threshold` exit with an explanation.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { governanceManifestCommitment, PDA_SEEDS, policyIdToBytes } from '@covantic/shared';

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

  for (const unsupported of ['upgrade-authority', 'controller', 'min-threshold']) {
    if (args.has(unsupported)) {
      throw new Error(
        `--${unsupported} is not accepted: the program cannot observe a program's upgrade ` +
          'authority or a multisig config from the covered token account, and refuses to ' +
          'record coverage it cannot settle.',
      );
    }
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

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.CONFIG)],
    program.programId,
  );
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

  const accounts = program.account as unknown as Record<
    string,
    { fetch: (a: PublicKey) => Promise<unknown> }
  >;
  const onChainPolicy = (await accounts.insurancePolicy!.fetch(policy)) as {
    agentAddress: PublicKey;
  };
  const onChainConfig = (await accounts.protocolConfig!.fetch(config)) as { usdcMint: PublicKey };
  const coveredTokenAccount = getAssociatedTokenAddressSync(
    onChainConfig.usdcMint,
    onChainPolicy.agentAddress,
  );

  // Defaults to the agent itself, which is the ordinary case: the agent owns
  // its own token accounts and nobody else may.
  const tokenOwner = optionalKey(args, 'token-owner') ?? onChainPolicy.agentAddress;
  const expectedDelegate = optionalKey(args, 'delegate');
  const expectedCloseAuthority = optionalKey(args, 'close-authority');
  const extraAuthorities = (args.get('operator') ?? []).map((k) => new PublicKey(k));
  if (extraAuthorities.length > 4) {
    throw new Error('At most 4 --operator addresses (MAX_GOVERNANCE_EXTRA_AUTHORITIES)');
  }
  const extensionHex = args.get('extension-hash')?.at(-1);
  const extensionHash = extensionHex
    ? Uint8Array.from(Buffer.from(extensionHex, 'hex'))
    : undefined;
  if (extensionHash && extensionHash.length !== 32) {
    throw new Error('--extension-hash must be 32 bytes of hex');
  }

  // Commits to the declaration as written — every field of it — plus the
  // digest of any richer off-chain document. The program cannot decode a
  // Squads config or an allowed-signer list, so the richer statement lives
  // off chain and this hash is what makes it permanently falsifiable.
  const manifestHash = governanceManifestCommitment({
    tokenOwner: tokenOwner.toBytes(),
    expectedDelegate: expectedDelegate?.toBytes() ?? null,
    expectedCloseAuthority: expectedCloseAuthority?.toBytes() ?? null,
    programUpgradeAuthority: null,
    controller: null,
    controllerMinThreshold: 0,
    extraAuthorities: extraAuthorities.map((k) => k.toBytes()),
    extensionHash,
  });

  const manifest = {
    tokenOwner,
    expectedDelegate,
    expectedCloseAuthority,
    programUpgradeAuthority: null,
    controller: null,
    controllerMinThreshold: 0,
    extraAuthorities,
    manifestHash: Array.from(manifestHash),
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
      config,
      policy,
      coveredTokenAccount,
      usdcMint: onChainConfig.usdcMint,
      baseline,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // Read it back rather than computing it — see the note in
  // `declare-agent-mandate.ts`. A `devnet-fast-lock` build compresses the
  // on-chain delay, and a locally-derived figure would tell a policyholder to
  // wait for something that has already happened.
  const onChain = (await accounts.governanceBaseline!.fetch(baseline)) as {
    effectiveAt: { toNumber(): number };
  };
  const effectiveAt = new Date(onChain.effectiveAt.toNumber() * 1000);
  process.stdout.write(
    [
      `Declared governance baseline for policy ${policyId}`,
      `  baseline PDA : ${baseline.toBase58()}`,
      `  token owner  : ${tokenOwner.toBase58()}`,
      `  delegate     : ${expectedDelegate?.toBase58() ?? '(none)'}`,
      `  close auth.  : ${expectedCloseAuthority?.toBase58() ?? '(none)'}`,
      `  operators    : ${extraAuthorities.map((k) => k.toBase58()).join(', ') || '(none)'}`,
      `  manifest hash: ${Buffer.from(manifestHash).toString('hex')}`,
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
