import { describe, expect, it } from 'vitest';
import type { RpcTransport } from '@solana/kit';
import { CovanticRpcPool } from '../src/config/rpc-pool.js';
import { createSolanaReader } from '../src/utils/solana-reader.js';

/**
 * INV-QUORUM-01 — a read that can close a claim is not decided by one endpoint.
 *
 * The proof instructions bound what an endpoint can *take*: each re-derives a
 * payout from state the program reads itself, so no RPC answer can overpay.
 * Rejection has no such floor. It is computed entirely off chain, it is
 * terminal, and until now its whole basis could be one endpoint's word — while
 * `SOLANA_RPC_FALLBACK_URLS` invites an operator to add endpoints they do not
 * run. For an insurance protocol, wrongful denial is the loss the product
 * exists to prevent.
 *
 * The claim being tested is narrow and worth stating exactly: two answers do
 * not make a lie impossible, they make it cost two endpoints instead of one,
 * and they turn a silent wrong verdict into a disagreement that reaches a
 * human.
 */

const A = 'https://rpc-a.example.org';
const B = 'https://rpc-b.example.org';
const PDA = 'HrLqdNdxUJq4pgsL4NsUqzfYrGxR7Hy9PHGEeHnj3skL';
const OWNER = '11111111111111111111111111111111';

/** An endpoint that reports the given account data for every read. */
function serving(data: string, owner = OWNER): RpcTransport {
  return (async () => ({
    jsonrpc: '2.0',
    id: 1,
    result: {
      context: { slot: 1n },
      value: { data: [data, 'base64'], executable: false, lamports: 2_039_280n, owner },
    },
  })) as unknown as RpcTransport;
}

/** An endpoint that says the account does not exist. */
function absent(): RpcTransport {
  return (async () => ({
    jsonrpc: '2.0',
    id: 1,
    result: { context: { slot: 1n }, value: null },
  })) as unknown as RpcTransport;
}

function readerOver(transports: Record<string, RpcTransport>) {
  const pool = new CovanticRpcPool({
    primaryUrl: A,
    fallbackUrls: B,
    transportFactory: (url) => transports[url]!,
  });
  return createSolanaReader(pool);
}

describe('INV-QUORUM-01 — a contested account read does not decide a claim', () => {
  it('returns the answer when both endpoints agree', async () => {
    const reader = readerOver({ [A]: serving('AQID'), [B]: serving('AQID') });

    const info = await reader.getAccountInfoCorroborated(PDA);

    expect(info?.data.toString('base64')).toBe('AQID');
  });

  it('refuses to answer when the two disagree about the data', async () => {
    // The attack this closes: a hostile endpoint returns a forged, matured
    // governance baseline naming the attacker as a legitimate authority, the
    // adjudicator sees control never left the declared set, and the holder's
    // genuine claim is `rejected` — a terminal status.
    const reader = readerOver({ [A]: serving('AQID'), [B]: serving('BBBB') });

    await expect(reader.getAccountInfoCorroborated(PDA)).rejects.toThrow(
      /endpoints disagree about/,
    );
  });

  it('refuses when one says the account exists and the other says it does not', async () => {
    // The cheaper lie: absence is what parks a claim on `no_governance_baseline`,
    // which `UNRESOLVABLE_PARK_REASONS` then lets any later alert supersede.
    const reader = readerOver({ [A]: serving('AQID'), [B]: absent() });

    await expect(reader.getAccountInfoCorroborated(PDA)).rejects.toThrow(
      /endpoints disagree about/,
    );
  });

  it('agrees that an account is absent when both say so', async () => {
    const reader = readerOver({ [A]: absent(), [B]: absent() });

    expect(await reader.getAccountInfoCorroborated(PDA)).toBeNull();
  });

  it('ignores a lamport difference, which moves with rent and decides nothing', async () => {
    // Comparing everything would manufacture disagreements out of a
    // rent-exemption top-up and send healthy claims to review.
    const rich = (async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: {
        context: { slot: 1n },
        value: { data: ['AQID', 'base64'], executable: false, lamports: 9_000_000n, owner: OWNER },
      },
    })) as unknown as RpcTransport;
    const reader = readerOver({ [A]: serving('AQID'), [B]: rich });

    expect((await reader.getAccountInfoCorroborated(PDA))?.data.toString('base64')).toBe('AQID');
  });

  it('catches an owner that differs, since that is what the decode is gated on', async () => {
    const reader = readerOver({ [A]: serving('AQID'), [B]: serving('AQID', PDA) });

    await expect(reader.getAccountInfoCorroborated(PDA)).rejects.toThrow(
      /endpoints disagree about/,
    );
  });

  it('degrades to a single read rather than failing when only one endpoint is configured', async () => {
    // Honest degradation: with nothing to compare against, the trust
    // assumption is what it was before the pool existed — not a hard failure
    // that would make a single-endpoint deployment unable to settle anything.
    const pool = new CovanticRpcPool({
      primaryUrl: A,
      transportFactory: () => serving('AQID'),
    });
    const reader = createSolanaReader(pool);

    expect((await reader.getAccountInfoCorroborated(PDA))?.data.toString('base64')).toBe('AQID');
  });

  it('falls back to the pool when one corroborating endpoint is unavailable', async () => {
    // One endpoint being down is not a disagreement, and treating it as one
    // would convert every partial outage into a wave of claims sent to review.
    const down = (async () => {
      throw new Error('connection refused');
    }) as unknown as RpcTransport;
    const reader = readerOver({ [A]: serving('AQID'), [B]: down });

    expect((await reader.getAccountInfoCorroborated(PDA))?.data.toString('base64')).toBe('AQID');
  });
});
