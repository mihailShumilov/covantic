import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  accountDiscriminator,
  fetchAllAnchorAccounts,
  fetchAnchorAccount,
} from '../src/utils/anchor-reader.js';
import type { CovanticProgram } from '../src/utils/program.js';
import type { AccountInfoView, SolanaReader } from '../src/utils/solana-reader.js';

/**
 * Anchor account reads over the endpoint pool.
 *
 * The distinctions tested here are the ones a holder's coverage rests on: an
 * absent declaration is `null` and sends a claim to review, while an outage or
 * a layout mismatch must throw and retry. Collapsing them would let a stale
 * IDL silently void every declaration on file.
 */

const PROGRAM_ID = new PublicKey('HrLqdNdxUJq4pgsL4NsUqzfYrGxR7Hy9PHGEeHnj3skL');
const DISCRIMINATOR = [171, 170, 55, 125, 71, 125, 63, 48];

function mkCtx(decode: (name: string, data: Buffer) => Record<string, unknown>): CovanticProgram {
  const ns = { coder: { accounts: { decode } } };
  return {
    programId: PROGRAM_ID,
    program: {
      account: { insurancePolicy: ns },
      idl: { accounts: [{ name: 'InsurancePolicy', discriminator: DISCRIMINATOR }] },
    },
  } as unknown as CovanticProgram;
}

function account(overrides: Partial<AccountInfoView> = {}): AccountInfoView {
  return {
    lamports: 2_039_280,
    owner: PROGRAM_ID.toBase58(),
    executable: false,
    data: Buffer.from(DISCRIMINATOR),
    ...overrides,
  };
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

describe('accountDiscriminator', () => {
  it('base58-encodes the discriminator the IDL declares', () => {
    expect(accountDiscriminator(mkCtx(() => ({})), 'insurancePolicy')).toBe('ViN9hevUmiF');
  });

  it('throws rather than guessing when the IDL has no such account', () => {
    expect(() => accountDiscriminator(mkCtx(() => ({})), 'noSuchAccount')).toThrow(
      /no discriminator/,
    );
  });
});

describe('fetchAnchorAccount', () => {
  it('returns null when the account does not exist', async () => {
    const reader = mkReader({ getAccountInfo: vi.fn(async () => null) });

    expect(await fetchAnchorAccount(mkCtx(() => ({})), reader, 'insurancePolicy', 'Abc')).toBeNull();
  });

  it('decodes an account the program owns', async () => {
    const reader = mkReader({ getAccountInfo: vi.fn(async () => account()) });
    const decode = vi.fn(() => ({ policyId: 7 }));

    const out = await fetchAnchorAccount(mkCtx(decode), reader, 'insurancePolicy', 'Abc');

    expect(out).toEqual({ policyId: 7 });
    expect(decode).toHaveBeenCalledWith('insurancePolicy', Buffer.from(DISCRIMINATOR));
  });

  it('refuses an account owned by another program', async () => {
    // Any account can be made to start with eight chosen bytes, so the
    // discriminator alone does not establish what this is.
    const reader = mkReader({
      getAccountInfo: vi.fn(async () => account({ owner: '11111111111111111111111111111111' })),
    });

    await expect(
      fetchAnchorAccount(mkCtx(() => ({})), reader, 'insurancePolicy', 'Abc'),
    ).rejects.toThrow(/owned by 11111111111111111111111111111111/);
  });

  it('propagates a decode failure instead of reading it as an absent account', async () => {
    const reader = mkReader({ getAccountInfo: vi.fn(async () => account()) });
    const ctx = mkCtx(() => {
      throw new Error('invalid account discriminator');
    });

    await expect(fetchAnchorAccount(ctx, reader, 'insurancePolicy', 'Abc')).rejects.toThrow(
      /invalid account discriminator/,
    );
  });

  it('propagates an RPC outage', async () => {
    const reader = mkReader({
      getAccountInfo: vi.fn(async () => {
        throw new Error('getAccountInfo: all RPC endpoints failed');
      }),
    });

    await expect(
      fetchAnchorAccount(mkCtx(() => ({})), reader, 'insurancePolicy', 'Abc'),
    ).rejects.toThrow(/all RPC endpoints failed/);
  });
});

describe('fetchAllAnchorAccounts', () => {
  it('filters by the account discriminator', async () => {
    const getProgramAccounts = vi.fn(async () => ({ accounts: [], slot: 42 }));
    const reader = mkReader({ getProgramAccounts });

    await fetchAllAnchorAccounts(mkCtx(() => ({})), reader, 'insurancePolicy');

    expect(getProgramAccounts).toHaveBeenCalledWith(PROGRAM_ID.toBase58(), 'ViN9hevUmiF');
  });

  it('keeps every account it can decode and drops the ones it cannot', async () => {
    const reader = mkReader({
      getProgramAccounts: vi.fn(async () => ({
        accounts: [
          { pubkey: 'A', account: account() },
          { pubkey: 'Orphan', account: account({ data: Buffer.alloc(4) }) },
          { pubkey: 'B', account: account() },
        ],
        slot: 42,
      })),
    });
    const ctx = mkCtx((_name, data) => {
      // An account left over from an earlier deployment is shorter than the
      // current layout. One of those must not stop the sweep reconciling the
      // policies that are current.
      if (data.length < 8) throw new Error('buffer too small');
      return { ok: true };
    });

    const out = await fetchAllAnchorAccounts(ctx, reader, 'insurancePolicy');

    expect(out.accounts.map((r) => r.publicKey)).toEqual(['A', 'B']);
  });

  it('propagates an RPC outage rather than reporting an empty program', async () => {
    // A partial view would look exactly like every policy having been closed.
    const reader = mkReader({
      getProgramAccounts: vi.fn(async () => {
        throw new Error('getProgramAccounts: all RPC endpoints failed');
      }),
    });

    await expect(
      fetchAllAnchorAccounts(mkCtx(() => ({})), reader, 'insurancePolicy'),
    ).rejects.toThrow(/all RPC endpoints failed/);
  });
});
