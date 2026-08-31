import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { MandateReader } from '../src/services/agent-error/mandate.js';
import { AuthorityCheckpointWriter } from '../src/services/governance/checkpoint.js';
import { readAgentBalances } from '../src/services/exploit/baseline.js';
import type { CovanticProgram } from '../src/utils/program.js';
import type { AccountInfoView, SolanaReader } from '../src/utils/solana-reader.js';
import { AGENT, ATTACKER, HOLDER, USDC, WSOL } from './fixtures/exploit.js';

/**
 * INV-THREE — three states at the declaration readers, not two.
 *
 * `anchor-reader.test.ts` proves `fetchAnchorAccount` keeps absence and outage
 * apart. It does not prove that the two readers a payout actually turns on —
 * the agent mandate and the governance baseline — preserve the distinction on
 * the way through, and nothing else did either: neither `readMandate` nor
 * `readBaseline` had a single test.
 *
 * The distinction is the whole coverage guarantee on two of four triggers.
 * `verifyAgentError` and `verifyGovernanceAttack` catch a *throw* into
 * `mandate_lookup_unavailable` / `baseline_lookup_unavailable`, which retries;
 * a `null` is "the holder never declared", which parks the claim for a human.
 * A reader that swallowed an RPC failure into `null` would convert every
 * outage during a real incident into a permanent gap in the record, and it
 * would do it silently, because nobody complains about a claim that was never
 * paid.
 *
 * The maturity half is the other direction of the same guard: a declaration
 * that had not matured before the claim was filed must not be usable as proof,
 * or a holder could watch a loss happen and then declare an envelope narrow
 * enough to have been breached by it.
 */

const PROGRAM_ID = new PublicKey('HrLqdNdxUJq4pgsL4NsUqzfYrGxR7Hy9PHGEeHnj3skL');
const OTHER_PROGRAM = '11111111111111111111111111111111';
const POLICY_ID = 42n;
const CLAIM_AT = 1_780_000_000;

/** Anchor's `.decode` never sees these bytes here — the coder is the stub. */
const ACCOUNT_BYTES = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

function mkCtx(accounts: Record<string, (name: string, data: Buffer) => unknown>): CovanticProgram {
  const namespace: Record<string, unknown> = {};
  for (const [name, decode] of Object.entries(accounts)) {
    namespace[name] = { coder: { accounts: { decode } } };
  }
  return {
    programId: PROGRAM_ID,
    program: { account: namespace, idl: { accounts: [] } },
  } as unknown as CovanticProgram;
}

function mkReader(over: Partial<SolanaReader>): SolanaReader {
  // A corroborated read degrades to a single one when fewer than two
  // endpoints are usable, which is exactly the case a stub represents. Wiring
  // the default here keeps every test that stubs `getAccountInfo` meaningful
  // instead of silently exercising an undefined method.
  return {
    getAccountInfoCorroborated: over.getAccountInfo,
    ...over,
  } as unknown as SolanaReader;
}

function found(overrides: Partial<AccountInfoView> = {}): AccountInfoView {
  return {
    lamports: 2_039_280,
    owner: PROGRAM_ID.toBase58(),
    executable: false,
    data: ACCOUNT_BYTES,
    ...overrides,
  };
}

/** An outage as `SolanaReader.rethrow` renders it. */
function outage(): never {
  throw new Error('getAccountInfo: all RPC endpoints failed (a.example: quota; b.example: 429)');
}

// ---------------------------------------------------------------------------
// Agent mandate
// ---------------------------------------------------------------------------

/** The shape Anchor hands back for `PolicyAgentMandate`, as BN-alikes. */
function rawMandate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    maxSingleOutflow: bn(500_000_000),
    maxWindowOutflow: bn(2_000_000_000),
    windowSeconds: bn(3_600),
    minRetainedBalance: bn(100_000_000),
    // A default key *inside* the declared count, and a real key *past* it —
    // the second is what a shrunk re-declaration leaves behind in the fixed
    // array, and reading it would silently re-permit a destination the holder
    // has removed.
    allowedCounterparties: [new PublicKey(HOLDER), PublicKey.default, new PublicKey(ATTACKER)],
    counterpartyCount: 2,
    allowedPrograms: [],
    programCount: 0,
    manifestHash: Array.from(Buffer.alloc(32, 7)),
    declaredAt: bn(CLAIM_AT - 7_200),
    effectiveAt: bn(CLAIM_AT - 3_600),
    prevMaxSingleOutflow: bn(0),
    prevMinRetainedBalance: bn(0),
    prevEffectiveAt: bn(0),
    ...over,
  };
}

/** Anchor returns BN, not number — a `{ toString() }` stand-in is faithful. */
function bn(n: number): { toString(): string } {
  return { toString: () => String(n) };
}

describe('INV-THREE-01 — MandateReader.readMandate', () => {
  const ctx = mkCtx({ policyAgentMandate: () => rawMandate() });

  it('returns null when the holder has never declared', async () => {
    // A policy older than the mechanism. The adjudicator turns this into
    // `no_mandate_declared` → review; it must never look like an outage.
    const reader = mkReader({ getAccountInfo: vi.fn(async () => null) });

    expect(await new MandateReader(ctx, reader).readMandate(HOLDER, POLICY_ID, CLAIM_AT)).toBeNull();
  });

  it('throws when the read itself failed', async () => {
    // The direction that costs coverage. A `null` here would tell the
    // adjudicator the holder never declared, closing the only route to a
    // payout on this trigger for as long as the provider is down.
    const reader = mkReader({ getAccountInfo: vi.fn(outage) });

    await expect(new MandateReader(ctx, reader).readMandate(HOLDER, POLICY_ID, CLAIM_AT)).rejects.toThrow(
      /all RPC endpoints failed/,
    );
  });

  it('throws rather than decoding an account another program owns', async () => {
    const reader = mkReader({ getAccountInfo: vi.fn(async () => found({ owner: OTHER_PROGRAM })) });

    await expect(new MandateReader(ctx, reader).readMandate(HOLDER, POLICY_ID, CLAIM_AT)).rejects.toThrow(
      /owned by/,
    );
  });

  it('throws when the layout and the loaded IDL disagree', async () => {
    // A redeploy with a stale IDL would otherwise read as "every holder
    // declaration on file has vanished".
    const stale = mkCtx({
      policyAgentMandate: () => {
        throw new Error('invalid account discriminator');
      },
    });
    const reader = mkReader({ getAccountInfo: vi.fn(async () => found()) });

    await expect(new MandateReader(stale, reader).readMandate(HOLDER, POLICY_ID, CLAIM_AT)).rejects.toThrow(
      /invalid account discriminator/,
    );
  });

  it('reads the mandate PDA derived from the policy, not one it was handed', async () => {
    const getAccountInfo = vi.fn(async () => null);
    const mandates = new MandateReader(ctx, mkReader({ getAccountInfo }));

    await mandates.readMandate(HOLDER, POLICY_ID, CLAIM_AT);

    const policy = mandates.derivePolicyPda(new PublicKey(HOLDER), POLICY_ID);
    expect(getAccountInfo).toHaveBeenCalledWith(mandates.deriveMandatePda(policy).toBase58());
  });

  it('accepts a declaration that matured before the claim', async () => {
    const reader = mkReader({ getAccountInfo: vi.fn(async () => found()) });

    const view = await new MandateReader(ctx, reader).readMandate(HOLDER, POLICY_ID, CLAIM_AT);

    expect(view?.maturedBeforeClaim).toBe(true);
    expect(view?.maxSingleOutflowRaw).toBe(500_000_000);
    expect(view?.minRetainedBalanceRaw).toBe(100_000_000);
    expect(view?.effectiveAt).toBe(CLAIM_AT - 3_600);
    // `counterpartyCount` bounds the array and the zero pubkey is dropped:
    // reading the padding as declared addresses would silently widen the
    // allowlist to include the default key.
    expect(view?.allowedCounterparties).toEqual([HOLDER]);
    expect(view?.allowedCounterparties).not.toContain(ATTACKER);
    expect(view?.allowedPrograms).toEqual([]);
  });

  it('refuses a first declaration written after the claim was filed', async () => {
    // The retroactive-narrowing manoeuvre. With `prev_*` at zero — which a
    // first declaration is required to leave them at — the fallback yields an
    // envelope that cannot support a payout, and says so.
    const immature = mkCtx({
      policyAgentMandate: () => rawMandate({ effectiveAt: bn(CLAIM_AT + 60) }),
    });
    const reader = mkReader({ getAccountInfo: vi.fn(async () => found()) });

    const view = await new MandateReader(immature, reader).readMandate(HOLDER, POLICY_ID, CLAIM_AT);

    expect(view).not.toBeNull();
    expect(view?.maturedBeforeClaim).toBe(false);
    expect(view?.effectiveAt).toBe(0);
    expect(view?.maxSingleOutflowRaw).toBe(0);
    expect(view?.minRetainedBalanceRaw).toBe(0);
  });

  it('falls back to the predecessor when a refresh landed after the claim', async () => {
    // A refresh that landed after the incident describes the aftermath; the
    // declaration it replaced is the one that still predates it.
    const refreshed = mkCtx({
      policyAgentMandate: () =>
        rawMandate({
          effectiveAt: bn(CLAIM_AT + 600),
          maxSingleOutflow: bn(1),
          minRetainedBalance: bn(999_999_999),
          prevMaxSingleOutflow: bn(750_000_000),
          prevMinRetainedBalance: bn(50_000_000),
          prevEffectiveAt: bn(CLAIM_AT - 86_400),
        }),
    });
    const reader = mkReader({ getAccountInfo: vi.fn(async () => found()) });

    const view = await new MandateReader(refreshed, reader).readMandate(HOLDER, POLICY_ID, CLAIM_AT);

    expect(view?.maturedBeforeClaim).toBe(true);
    expect(view?.effectiveAt).toBe(CLAIM_AT - 86_400);
    expect(view?.maxSingleOutflowRaw).toBe(750_000_000);
    expect(view?.minRetainedBalanceRaw).toBe(50_000_000);
  });

  it('treats a declaration effective exactly at the claim instant as matured', async () => {
    const boundary = mkCtx({
      policyAgentMandate: () => rawMandate({ effectiveAt: bn(CLAIM_AT) }),
    });
    const reader = mkReader({ getAccountInfo: vi.fn(async () => found()) });

    const view = await new MandateReader(boundary, reader).readMandate(HOLDER, POLICY_ID, CLAIM_AT);

    // The program's comparison is `<=`; an off-chain `<` would deny a
    // declaration the chain would accept, which is the wrong direction.
    expect(view?.maturedBeforeClaim).toBe(true);
    expect(view?.maxSingleOutflowRaw).toBe(500_000_000);
  });
});

// ---------------------------------------------------------------------------
// Governance baseline
// ---------------------------------------------------------------------------

function rawBaseline(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokenOwner: new PublicKey(AGENT),
    expectedDelegate: null,
    expectedCloseAuthority: null,
    programUpgradeAuthority: null,
    controller: new PublicKey(HOLDER),
    controllerMinThreshold: 2,
    extraAuthorities: [new PublicKey(USDC), PublicKey.default, new PublicKey(WSOL)],
    extraAuthorityCount: 2,
    manifestHash: Array.from(Buffer.alloc(32, 3)),
    effectiveAt: bn(CLAIM_AT - 3_600),
    ...over,
  };
}

describe('INV-THREE-02 — AuthorityCheckpointWriter.readBaseline', () => {
  const ctx = mkCtx({ governanceBaseline: () => rawBaseline() });

  it('returns null when the holder has never declared', async () => {
    const reader = mkReader({ getAccountInfo: vi.fn(async () => null) });

    expect(
      await new AuthorityCheckpointWriter(ctx, reader).readBaseline(HOLDER, POLICY_ID, CLAIM_AT),
    ).toBeNull();
  });

  it('throws when the read itself failed', async () => {
    const reader = mkReader({ getAccountInfo: vi.fn(outage) });

    await expect(
      new AuthorityCheckpointWriter(ctx, reader).readBaseline(HOLDER, POLICY_ID, CLAIM_AT),
    ).rejects.toThrow(/all RPC endpoints failed/);
  });

  it('throws rather than decoding an account another program owns', async () => {
    const reader = mkReader({ getAccountInfo: vi.fn(async () => found({ owner: OTHER_PROGRAM })) });

    await expect(
      new AuthorityCheckpointWriter(ctx, reader).readBaseline(HOLDER, POLICY_ID, CLAIM_AT),
    ).rejects.toThrow(/owned by/);
  });

  it('throws when the layout and the loaded IDL disagree', async () => {
    const stale = mkCtx({
      governanceBaseline: () => {
        throw new Error('invalid account discriminator');
      },
    });
    const reader = mkReader({ getAccountInfo: vi.fn(async () => found()) });

    await expect(
      new AuthorityCheckpointWriter(stale, reader).readBaseline(HOLDER, POLICY_ID, CLAIM_AT),
    ).rejects.toThrow(/invalid account discriminator/);
  });

  it('reads the baseline PDA derived from the policy', async () => {
    const getAccountInfo = vi.fn(async () => null);
    const writer = new AuthorityCheckpointWriter(ctx, mkReader({ getAccountInfo }));

    await writer.readBaseline(HOLDER, POLICY_ID, CLAIM_AT);

    const policy = writer.derivePolicyPda(new PublicKey(HOLDER), POLICY_ID);
    expect(getAccountInfo).toHaveBeenCalledWith(writer.deriveBaselinePda(policy).toBase58());
  });

  it('flattens the declared set, bounded by the declared count', async () => {
    const reader = mkReader({ getAccountInfo: vi.fn(async () => found()) });

    const view = await new AuthorityCheckpointWriter(ctx, reader).readBaseline(
      HOLDER,
      POLICY_ID,
      CLAIM_AT,
    );

    expect(view?.maturedBeforeClaim).toBe(true);
    expect(view?.tokenOwner).toBe(AGENT);
    // `extraAuthorityCount` is 2, so the third slot is padding and the default
    // key inside the counted prefix is dropped. Admitting either would add an
    // address the holder never declared to the permitted set.
    expect(view?.extraAuthorities).toEqual([USDC]);
    expect(view?.authorities).toEqual([AGENT, HOLDER, USDC].sort());
  });

  it('refuses a baseline that had not matured when the claim was filed', async () => {
    const immature = mkCtx({
      governanceBaseline: () => rawBaseline({ effectiveAt: bn(CLAIM_AT + 1) }),
    });
    const reader = mkReader({ getAccountInfo: vi.fn(async () => found()) });

    const view = await new AuthorityCheckpointWriter(immature, reader).readBaseline(
      HOLDER,
      POLICY_ID,
      CLAIM_AT,
    );

    // Still returned — the adjudicator needs to say *why* — but not usable.
    expect(view).not.toBeNull();
    expect(view?.maturedBeforeClaim).toBe(false);
  });

  it('treats a never-matured baseline (effectiveAt 0) as not matured', async () => {
    const zero = mkCtx({ governanceBaseline: () => rawBaseline({ effectiveAt: bn(0) }) });
    const reader = mkReader({ getAccountInfo: vi.fn(async () => found()) });

    const view = await new AuthorityCheckpointWriter(zero, reader).readBaseline(
      HOLDER,
      POLICY_ID,
      CLAIM_AT,
    );

    expect(view?.maturedBeforeClaim).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Live holdings
// ---------------------------------------------------------------------------

describe('INV-THREE-03 — readAgentBalances refuses a partial snapshot', () => {
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

  it('throws when one token program is unreadable rather than truncating', async () => {
    // A partial snapshot understates holdings, and every drain ratio is
    // measured against it — so a truncated read inflates the ratio and can
    // manufacture a "material drop" out of an outage.
    const reader = mkReader({
      getBalanceAndSlot: vi.fn(async () => ({ lamports: 1_000_000_000, slot: 1 })),
      getParsedTokenAccountsByOwner: vi.fn(async (_owner: string, filter: { programId?: string }) => {
        if (filter.programId === TOKEN) {
          return {
            accounts: [
              { pubkey: 'a', mint: USDC, owner: AGENT, amount: '1000', decimals: 6, state: 'initialized' },
            ],
            slot: 1,
          };
        }
        throw new Error('getTokenAccountsByOwner: all RPC endpoints failed');
      }) as unknown as SolanaReader['getParsedTokenAccountsByOwner'],
    });

    await expect(readAgentBalances(reader, AGENT)).rejects.toThrow(/token accounts unreadable/);
  });

  it('throws when the lamport read is unreadable', async () => {
    const reader = mkReader({
      getBalanceAndSlot: vi.fn(async () => {
        throw new Error('getBalance: all RPC endpoints failed');
      }) as unknown as SolanaReader['getBalanceAndSlot'],
    });

    await expect(readAgentBalances(reader, AGENT)).rejects.toThrow(/all RPC endpoints failed/);
  });

  it('reports an agent holding nothing as an empty position, not a failure', async () => {
    const reader = mkReader({
      getBalanceAndSlot: vi.fn(async () => ({ lamports: 0, slot: 7 })),
      getParsedTokenAccountsByOwner: vi.fn(async () => ({ accounts: [], slot: 7 })),
    });

    const out = await readAgentBalances(reader, AGENT);

    expect(out.slot).toBe(7);
    expect(out.frozen).toEqual([]);
    expect(out.readings.every((r) => r.amountRaw === 0)).toBe(true);
  });

  it('keeps a frozen holding in readings and reports it separately', async () => {
    // Frozen is the opposite of missing and still lost: it must not read as a
    // drop, and it must still be visible to the governance path.
    const reader = mkReader({
      getBalanceAndSlot: vi.fn(async () => ({ lamports: 0, slot: 1 })),
      getParsedTokenAccountsByOwner: vi.fn(async (_o: string, filter: { programId?: string }) =>
        filter.programId === TOKEN
          ? {
              accounts: [
                { pubkey: 'a', mint: USDC, owner: AGENT, amount: '5000000', decimals: 6, state: 'frozen' },
              ],
              slot: 1,
            }
          : { accounts: [], slot: 1 },
      ) as unknown as SolanaReader['getParsedTokenAccountsByOwner'],
    });

    const out = await readAgentBalances(reader, AGENT);

    expect(out.readings.find((r) => r.mint === USDC)?.amountRaw).toBe(5_000_000);
    expect(out.frozen).toEqual([{ mint: USDC, amountRaw: 5_000_000, decimals: 6 }]);
  });
});
