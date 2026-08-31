import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { RpcTransport } from '@solana/kit';
import { CovanticRpcPool } from '../src/config/rpc-pool.js';
import { SolanaReader, type ParsedTransactionView } from '../src/utils/solana-reader.js';
import { toRawTxView, type RawTxView } from '../src/services/exploit/raw-tx.js';
import { positionFromRawTx } from '../src/services/exploit/position.js';
import { analyseAuthorization } from '../src/services/exploit/authorization.js';
import { bundleHash, canonicalize, verdictHash } from '../src/services/oracle/hash.js';
import { AGENT, AGENT_USDC_ATA, ATTACKER, HOLDER, OTHER_ATA, TOKEN_PROGRAM, USDC } from './fixtures/exploit.js';

/**
 * INV-DET-04 — the transport swap did not move a single byte of evidence.
 *
 * `bundle_hash` is posted on chain and `pnpm claim:replay` re-derives stored
 * verdicts from it, so the canonical JSON of an evidence bundle is a public
 * commitment with a history. Replacing the web3.js-v1 `Connection` with
 * `SolanaReader` changed *how* the same transaction is fetched; if it also
 * changed what the bundle looks like, every stored verdict silently stops
 * agreeing with its own evidence and nobody finds out until a replay is run.
 *
 * So this is a differential test, which is the strongest form available here:
 * one logical transaction is rendered twice — once as web3.js v1 handed it
 * over (`PublicKey` instances, JS numbers, `ParsedTransactionWithMeta`) and
 * once as `@solana/kit` puts it on the wire (plain JSON, then widened to
 * `bigint` by the kit's own response transformer) — and both are required to
 * hash identically.
 *
 * The committed golden hash is the third leg. Without it, a change that
 * corrupts *both* renderings the same way still passes.
 */

const SIGNATURE =
  '4sozofKWzt8vLXHTWQpYS4PSduqvaC8C8ADVHnE4Sbi26j7QcgYF41Bs2pbRtSVNBbk73KBseSUksHS7XLZXSHw9';

const SLOT = 380_123_456;
const BLOCK_TIME = 1_780_000_000;
const FEE = 5_000;

/**
 * The transaction both renderings describe: a delegate drains the agent's USDC
 * account into an attacker-controlled one, with the transfer as a CPI.
 *
 * Chosen because it exercises every field that differs between the two
 * transports at once — signer flags, per-side token-account owners, a parsed
 * inner instruction, an opaque outer instruction with `PublicKey` accounts,
 * and a `null` err.
 */
const KEYS = [
  { pubkey: ATTACKER, signer: true, writable: true },
  { pubkey: AGENT_USDC_ATA, signer: false, writable: true },
  { pubkey: OTHER_ATA, signer: false, writable: true },
  { pubkey: AGENT, signer: false, writable: false },
  { pubkey: TOKEN_PROGRAM, signer: false, writable: false },
];

const PRE_BALANCES = [1_000_000_000, 2_039_280, 2_039_280, 890_880, 1];
const POST_BALANCES = [999_995_000, 2_039_280, 2_039_280, 890_880, 1];

const PRE_TOKEN = [
  {
    accountIndex: 1,
    mint: USDC,
    owner: AGENT,
    uiTokenAmount: { amount: '2000000000', decimals: 6, uiAmount: 2000, uiAmountString: '2000' },
  },
  {
    accountIndex: 2,
    mint: USDC,
    owner: ATTACKER,
    uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
  },
];

const POST_TOKEN = [
  {
    accountIndex: 1,
    mint: USDC,
    owner: AGENT,
    uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
  },
  {
    accountIndex: 2,
    mint: USDC,
    owner: ATTACKER,
    uiTokenAmount: { amount: '2000000000', decimals: 6, uiAmount: 2000, uiAmountString: '2000' },
  },
];

const TRANSFER_INFO = {
  source: AGENT_USDC_ATA,
  destination: OTHER_ATA,
  authority: ATTACKER,
  amount: '2000000000',
};

const LOGS = [
  'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]',
  'Program log: Instruction: Transfer',
  'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
];

// ---------------------------------------------------------------------------
// Rendering A — the kit wire shape, fetched through the real SolanaReader
// ---------------------------------------------------------------------------

/**
 * Exactly what a `jsonParsed` `getTransaction` response carries over HTTP:
 * addresses as base58 strings, every integer as a JSON number. The kit's own
 * response transformer widens the u64 keypaths to `bigint` on the way in,
 * which is precisely the hazard the reader exists to absorb.
 */
const KIT_WIRE_RESPONSE = {
  slot: SLOT,
  blockTime: BLOCK_TIME,
  version: 0,
  meta: {
    err: null,
    status: { Ok: null },
    fee: FEE,
    computeUnitsConsumed: 18_233,
    preBalances: PRE_BALANCES,
    postBalances: POST_BALANCES,
    preTokenBalances: PRE_TOKEN.map((b) => ({ ...b, programId: TOKEN_PROGRAM })),
    postTokenBalances: POST_TOKEN.map((b) => ({ ...b, programId: TOKEN_PROGRAM })),
    innerInstructions: [
      {
        index: 0,
        instructions: [
          {
            program: 'spl-token',
            programId: TOKEN_PROGRAM,
            parsed: { type: 'transfer', info: TRANSFER_INFO },
            stackHeight: 2,
          },
        ],
      },
    ],
    logMessages: LOGS,
    loadedAddresses: { readonly: [], writable: [] },
    rewards: [],
  },
  transaction: {
    signatures: [SIGNATURE],
    message: {
      accountKeys: KEYS.map((k) => ({ ...k, source: 'transaction' })),
      instructions: [
        {
          programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
          accounts: [AGENT_USDC_ATA, OTHER_ATA, TOKEN_PROGRAM],
          data: '3Bxs4h24hBtQy9rw',
          stackHeight: null,
        },
      ],
      recentBlockhash: '11111111111111111111111111111111',
    },
  },
};

async function readThroughKit(): Promise<ParsedTransactionView> {
  const transport = (async () => ({
    jsonrpc: '2.0',
    id: 1,
    result: KIT_WIRE_RESPONSE,
  })) as unknown as RpcTransport;
  const reader = new SolanaReader(
    new CovanticRpcPool({ primaryUrl: 'https://rpc.example.test', transportFactory: () => transport }),
  );
  const view = await reader.getParsedTransaction(SIGNATURE);
  expect(view).not.toBeNull();
  return view!;
}

// ---------------------------------------------------------------------------
// Rendering B — web3.js v1's ParsedTransactionWithMeta, as it used to arrive
// ---------------------------------------------------------------------------

/**
 * The same transaction in the shape `Connection.getParsedTransaction` returned
 * before the swap.
 *
 * The differences that matter are all here: `pubkey`, `programId` and the
 * opaque instruction's `accounts` are `PublicKey` *instances* rather than
 * strings, and every integer is a JS `number` rather than a `bigint`. If
 * `toRawTxView` had ever stopped calling `String(...)` on those, the two
 * renderings would diverge — a `PublicKey` canonicalises to
 * `{"_bn":{...}}`, not to its base58 form.
 */
const V1_RESPONSE = {
  slot: SLOT,
  blockTime: BLOCK_TIME,
  version: 0,
  meta: {
    err: null,
    fee: FEE,
    computeUnitsConsumed: 18_233,
    preBalances: PRE_BALANCES,
    postBalances: POST_BALANCES,
    preTokenBalances: PRE_TOKEN,
    postTokenBalances: POST_TOKEN,
    innerInstructions: [
      {
        index: 0,
        instructions: [
          {
            program: 'spl-token',
            programId: new PublicKey(TOKEN_PROGRAM),
            parsed: { type: 'transfer', info: TRANSFER_INFO },
          },
        ],
      },
    ],
    logMessages: LOGS,
    loadedAddresses: { readonly: [], writable: [] },
    rewards: [],
  },
  transaction: {
    signatures: [SIGNATURE],
    message: {
      accountKeys: KEYS.map((k) => ({
        pubkey: new PublicKey(k.pubkey),
        signer: k.signer,
        writable: k.writable,
      })),
      instructions: [
        {
          programId: new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'),
          accounts: [AGENT_USDC_ATA, OTHER_ATA, TOKEN_PROGRAM].map((a) => new PublicKey(a)),
          data: '3Bxs4h24hBtQy9rw',
        },
      ],
      recentBlockhash: '11111111111111111111111111111111',
    },
  },
} as unknown as ParsedTransactionView;

// ---------------------------------------------------------------------------
// The bundle both renderings feed
// ---------------------------------------------------------------------------

/**
 * An exploit-shaped evidence bundle over a `RawTxView`.
 *
 * `position` and `authorization` are computed with the production functions
 * rather than stubbed, because they are where the transaction's fields
 * actually reach a hashed bundle — a divergence in `owner` or in a signer flag
 * shows up there and nowhere else.
 */
function bundleFor(view: RawTxView): Record<string, unknown> {
  const position = positionFromRawTx(view, AGENT);
  return {
    version: 1,
    triggerType: 1,
    txSignature: view.signature,
    agentAddress: AGENT,
    holderAddress: HOLDER,
    slot: view.slot,
    blockTime: view.blockTime,
    hasRawTx: true,
    view: view as unknown as Record<string, unknown>,
    position: position as unknown as Record<string, unknown>,
    authorization: analyseAuthorization({
      view,
      position,
      agentAddress: AGENT,
      holderAddress: HOLDER,
    }) as unknown as Record<string, unknown>,
    // Provenance: excluded from the hash by `bundleHash`, and set to different
    // values on the two sides so the exclusion is exercised rather than
    // assumed.
    collectedAt: 0,
    stage: 'verify',
  };
}

/**
 * The evidence hash of this transaction, frozen.
 *
 * Regenerate ONLY with a deliberate, documented bundle-version bump: this
 * value is the shape of every stored `claim_evidence.bundle_hash` and of every
 * `bundle_hash` already committed on chain. A diff here is not a test to
 * update, it is a migration to plan.
 */
const GOLDEN_BUNDLE_HASH = '741eb709163c4aea550b4fe0e12c2d900ea42909d8dec7a09b684c2ef0a320ac';

describe('INV-DET-04 — evidence hash is stable across the transport swap', () => {
  it('renders the same RawTxView from the kit and the v1 shapes', async () => {
    const fromKit = toRawTxView(await readThroughKit(), SIGNATURE);
    const fromV1 = toRawTxView(V1_RESPONSE, SIGNATURE);

    expect(fromKit).toEqual(fromV1);
    // Field-level, so a failure names what moved rather than dumping both.
    expect(fromKit.slot).toBe(SLOT);
    expect(fromKit.blockTime).toBe(BLOCK_TIME);
    expect(fromKit.fee).toBe(FEE);
    expect(fromKit.accountKeys.map((k) => k.pubkey)).toEqual(KEYS.map((k) => k.pubkey));
    expect(fromKit.instructions.map((i) => i.programId)).toEqual(fromV1.instructions.map((i) => i.programId));
    expect(fromKit.preTokenBalances.map((b) => b.owner)).toEqual([AGENT, ATTACKER]);
  });

  it('canonicalises to identical bytes', async () => {
    const kit = canonicalize(bundleFor(toRawTxView(await readThroughKit(), SIGNATURE)));
    const v1 = canonicalize(bundleFor(toRawTxView(V1_RESPONSE, SIGNATURE)));

    expect(kit).toBe(v1);
    // A `PublicKey` that survived into the bundle canonicalises through its
    // internal BN, which is the specific corruption this guards against.
    expect(kit).not.toContain('_bn');
  });

  it('produces one bundle hash, and it is the committed one', async () => {
    const kitHash = bundleHash(bundleFor(toRawTxView(await readThroughKit(), SIGNATURE)));
    const v1Hash = bundleHash(bundleFor(toRawTxView(V1_RESPONSE, SIGNATURE)));

    expect(kitHash).toBe(v1Hash);
    expect(kitHash).toBe(GOLDEN_BUNDLE_HASH);
  });

  it('binds the verdict to that hash identically on both transports', async () => {
    const verdict = { outcome: 'confirmed', lossAmount: 2_000_000_000, confidence: 0.92 };
    const kitHash = bundleHash(bundleFor(toRawTxView(await readThroughKit(), SIGNATURE)));
    const v1Hash = bundleHash(bundleFor(toRawTxView(V1_RESPONSE, SIGNATURE)));

    expect(verdictHash(kitHash, verdict)).toBe(verdictHash(v1Hash, verdict));
  });

  it('excludes provenance, so re-collecting the same evidence rehashes the same', async () => {
    const view = toRawTxView(await readThroughKit(), SIGNATURE);
    const first = { ...bundleFor(view), collectedAt: 1, stage: 'screen' };
    const second = { ...bundleFor(view), collectedAt: 999_999, stage: 'verify' };

    expect(bundleHash(first)).toBe(bundleHash(second));
  });

  it('is not hash-blind: a changed authorization fact changes the hash', async () => {
    // Guards the golden itself. A bundle builder that dropped a field would
    // still agree across transports and still match a golden regenerated from
    // the broken build; this asserts the hash actually depends on the evidence.
    const view = toRawTxView(await readThroughKit(), SIGNATURE);
    const tampered: RawTxView = {
      ...view,
      accountKeys: view.accountKeys.map((k) =>
        k.pubkey === ATTACKER ? { ...k, signer: false } : k,
      ),
    };

    expect(bundleHash(bundleFor(tampered))).not.toBe(bundleHash(bundleFor(view)));
  });
});
