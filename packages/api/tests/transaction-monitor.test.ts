import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PolicyState } from '@covantic/shared';
import { TransactionMonitor } from '../src/services/transaction-monitor.js';
import type { PriceOracle, PriceWindow } from '../src/services/oracle/types.js';

/**
 * Unit tests for TransactionMonitor.
 *
 * The monitor talks to Drizzle (select / insert) and Redis (incr / publish).
 * Both are stubbed with spy-friendly fakes so we can assert decisions
 * without standing up Postgres. The `db.select(...).from(...).where(...)`
 * chain is the only Drizzle shape the monitor uses, so the fake only
 * implements that chain plus `insert(...).values(...)`.
 */

type PolicyRow = {
  agentAddress: string;
  holderAddress: string;
  policyId: number;
  state: number;
};

interface FakeDb {
  /** Fault injection hook, called once per query. */
  onQuery?: () => void;
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  inserted: Array<{ table: unknown; values: unknown }>;
  lookupRows: PolicyRow[];
}

function makeFakeDb(lookupRows: PolicyRow[]): FakeDb {
  const db: FakeDb = {
    select: vi.fn(),
    insert: vi.fn(),
    inserted: [],
    lookupRows,
  };

  // Two query shapes reach this fake: the policy lookup
  // (`select().from().where()`) and the balance-baseline read, which adds
  // `.orderBy().limit()`. The chainable object satisfies both, and is itself
  // awaitable so either shape can be the terminal call.
  db.select.mockImplementation(() => ({
    from: () => {
      const chain = {
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: (rows: PolicyRow[]) => unknown, reject: (err: unknown) => unknown) =>
          Promise.resolve()
            .then(() => db.onQuery?.())
            .then(() => db.lookupRows)
            .then(resolve, reject),
      };
      return chain;
    },
  }));

  // `values()` returns a thenable that also carries `onConflictDoNothing`,
  // because the monitor now writes two shapes: monitoring events, which are
  // awaited directly, and outflow observations, which are idempotent.
  db.insert.mockImplementation((table: unknown) => ({
    values: (values: unknown) => {
      db.inserted.push({ table, values });
      const done = Promise.resolve();
      return {
        onConflictDoNothing: () => done,
        then: done.then.bind(done),
        catch: done.catch.bind(done),
      };
    },
  }));

  return db;
}

interface FakeRedis {
  incrby: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  counters: Record<string, number>;
  publishes: Array<{ channel: string; raw: string }>;
}

function makeFakeRedis(): FakeRedis {
  const redis: FakeRedis = {
    incrby: vi.fn(),
    publish: vi.fn(),
    counters: {},
    publishes: [],
  };
  redis.incrby.mockImplementation(async (key: string, by: number) => {
    redis.counters[key] = (redis.counters[key] ?? 0) + by;
    return redis.counters[key];
  });
  redis.publish.mockImplementation(async (channel: string, raw: string) => {
    redis.publishes.push({ channel, raw });
    return 1;
  });
  return redis;
}

/** Monitoring-event rows only. The monitor also records outflow
 *  observations, which are history rather than findings. */
function events(db: FakeDb): Array<Record<string, unknown>> {
  return db.inserted
    .map((i) => i.values as Record<string, unknown>)
    .filter((v) => typeof v.eventType === 'string');
}

const ALERT_SECRET = 'test-alert-secret';
const AGENT_A = 'AgentAddressAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const AGENT_B = 'AgentAddressBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const HOLDER = 'HolderAddressCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

// Helius Enhanced Transactions deliver `tokenAmount` as a decimal-aware
// UI amount (e.g. `2000.0` for a 2,000 USDC transfer), matching what the
// monitor compares against. These fixtures mirror that: `LARGE` is just
// above the 1,000 UI threshold and `CRITICAL` just above 10,000.
const LARGE = 2_000;
const CRITICAL = 20_000;
const SUB_THRESHOLD = 500;

/** Registered mint. The screen values a movement *per mint*, so a fixture
 *  without one is not a transfer it can reason about — which is the bug the
 *  `junk airdrop` case below pins down. */
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const JUNK_MINT = 'Di91ieQpSMN8TA6Y4rKyAkTBK7AsJVXHk7ouYUDrZ5Jp';

/** One outgoing transfer in the shape Helius actually delivers. */
function out(from: string, tokenAmount: number, mint = USDC_MINT) {
  return { fromUserAccount: from, tokenAmount, mint };
}

describe('TransactionMonitor.processTransaction', () => {
  let db: FakeDb;
  let redis: FakeRedis;
  let monitor: TransactionMonitor;

  beforeEach(() => {
    db = makeFakeDb([]);
    redis = makeFakeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    monitor = new TransactionMonitor(db as any, redis as any, ALERT_SECRET);
  });

  it('matches an active policy and writes event + publishes alert', async () => {
    db.lookupRows = [{ agentAddress: AGENT_A, holderAddress: HOLDER, policyId: 1, state: PolicyState.Active }];

    await monitor.processWebhook([
      {
        signature: 'sig-active-large',
        tokenTransfers: [out(AGENT_A, LARGE)],
      },
    ]);

    expect(events(db)).toHaveLength(1);
    const row = events(db)[0]!;
    expect(row.agentAddress).toBe(AGENT_A);
    expect(row.eventType).toBe('large_transfer');
    expect(row.severity).toBe('warning');
    expect(row.txSignature).toBe('sig-active-large');

    expect(redis.publishes).toHaveLength(1);
    expect(redis.publishes[0]!.channel).toBe('monitoring:alerts');

    expect(redis.counters['covantic:metrics:monitor:matched:active']).toBe(1);
    expect(redis.counters['covantic:metrics:monitor:anomaly:warning']).toBe(1);
  });

  it('escalates to critical severity above the critical threshold', async () => {
    db.lookupRows = [{ agentAddress: AGENT_A, holderAddress: HOLDER, policyId: 1, state: PolicyState.Active }];

    await monitor.processWebhook([
      {
        signature: 'sig-critical',
        tokenTransfers: [out(AGENT_A, CRITICAL)],
      },
    ]);

    const row = events(db)[0]!;
    expect(row.severity).toBe('critical');
    expect(redis.counters['covantic:metrics:monitor:anomaly:critical']).toBe(1);
    expect(redis.counters['covantic:metrics:monitor:anomaly:warning'] ?? 0).toBe(0);
  });

  it('skips when the policy exists but is Expired', async () => {
    db.lookupRows = [{ agentAddress: AGENT_A, holderAddress: HOLDER, policyId: 1, state: PolicyState.Expired }];

    await monitor.processWebhook([
      {
        signature: 'sig-expired',
        tokenTransfers: [out(AGENT_A, LARGE)],
      },
    ]);

    expect(events(db)).toHaveLength(0);
    expect(redis.publishes).toHaveLength(0);
    expect(redis.counters['covantic:metrics:monitor:skipped:inactive_policy']).toBe(1);
    expect(redis.counters['covantic:metrics:monitor:matched:active'] ?? 0).toBe(0);
  });

  it('skips when the policy is ClaimPending (not Active)', async () => {
    db.lookupRows = [{ agentAddress: AGENT_A, holderAddress: HOLDER, policyId: 1, state: PolicyState.ClaimPending }];

    await monitor.processWebhook([
      {
        signature: 'sig-claim-pending',
        tokenTransfers: [out(AGENT_A, LARGE)],
      },
    ]);

    expect(events(db)).toHaveLength(0);
    expect(redis.counters['covantic:metrics:monitor:skipped:inactive_policy']).toBe(1);
  });

  it('skips an uninsured agent and counts it distinctly', async () => {
    db.lookupRows = []; // no rows for this agent

    await monitor.processWebhook([
      {
        signature: 'sig-uninsured',
        tokenTransfers: [out(AGENT_A, LARGE)],
      },
    ]);

    expect(events(db)).toHaveLength(0);
    expect(redis.counters['covantic:metrics:monitor:skipped:uninsured']).toBe(1);
    expect(redis.counters['covantic:metrics:monitor:skipped:inactive_policy'] ?? 0).toBe(0);
  });

  it('does nothing when a webhook carries no fromUserAccount addresses', async () => {
    db.lookupRows = [];

    await monitor.processWebhook([
      { signature: 'sig-empty', tokenTransfers: [] },
    ]);

    expect(events(db)).toHaveLength(0);
    expect(redis.publishes).toHaveLength(0);
    expect(redis.counters['covantic:metrics:monitor:skipped:no_addresses']).toBe(1);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('does not flag a sub-threshold transfer as anomalous', async () => {
    db.lookupRows = [{ agentAddress: AGENT_A, holderAddress: HOLDER, policyId: 1, state: PolicyState.Active }];

    await monitor.processWebhook([
      {
        signature: 'sig-small',
        tokenTransfers: [out(AGENT_A, SUB_THRESHOLD)],
      },
    ]);

    expect(events(db)).toHaveLength(0);
    expect(redis.publishes).toHaveLength(0);
    expect(redis.counters['covantic:metrics:monitor:matched:active']).toBe(1);
    expect(redis.counters['covantic:metrics:monitor:anomaly:warning'] ?? 0).toBe(0);
  });

  // Regression: a real Helius payload delivers UI-decimal tokenAmounts.
  // Prior to this fix the threshold was in raw lamports (1e9), so a 2,000
  // USDC transfer (tokenAmount: 2000) never triggered large_transfer and
  // the entire claim pipeline went silent on live traffic. Keep this test
  // to prevent the unit drift from coming back.
  it('fires large_transfer for a realistic UI-decimal Helius payload', async () => {
    db.lookupRows = [{ agentAddress: AGENT_A, holderAddress: HOLDER, policyId: 1, state: PolicyState.Active }];

    await monitor.processWebhook([
      {
        signature: 'sig-real-helius',
        tokenTransfers: [out(AGENT_A, 2_000)],
      },
    ]);

    expect(events(db)).toHaveLength(1);
    const row = events(db)[0]!;
    expect(row.eventType).toBe('large_transfer');
    const details = row.details as { outflowUi?: number };
    expect(details.outflowUi).toBe(2_000);
    expect(redis.counters['covantic:metrics:monitor:anomaly:warning']).toBe(1);
  });

  // Regression: the threshold summed `tokenAmount` across every transfer with
  // no reference to the mint, so a number reasoned about as dollars was
  // compared against a count of tokens. 1,001 units of a worthless airdrop
  // fired it; 0.4 WBTC did not.
  it('does not fire on a large *count* of a worthless token', async () => {
    db.lookupRows = [
      { agentAddress: AGENT_A, holderAddress: HOLDER, policyId: 1, state: PolicyState.Active },
    ];

    await monitor.processWebhook([
      {
        signature: 'sig-junk-airdrop',
        tokenTransfers: [out(AGENT_A, 50_000, JUNK_MINT)],
      },
    ]);

    // Flagged, but as an *unpriceable* movement rather than a large one:
    // detection fails open, so a mint the registry does not know still reaches
    // a human. What must not happen is it being counted as 50,000 dollars.
    const rows = events(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe('large_transfer');
    expect((rows[0]!.details as { screenReason?: string }).screenReason).toBe(
      'unpriceable_outflow',
    );
    expect(redis.counters['covantic:metrics:monitor:anomaly:critical'] ?? 0).toBe(0);
  });

  // Regression: detection ran inside the per-transfer loop, so a transaction
  // with several outgoing legs produced one copy of every anomaly per leg —
  // each its own row and its own alert for the same event.
  it('raises one anomaly per agent per transaction, not per transfer', async () => {
    db.lookupRows = [
      { agentAddress: AGENT_A, holderAddress: HOLDER, policyId: 1, state: PolicyState.Active },
    ];

    await monitor.processWebhook([
      {
        signature: 'sig-multi-leg',
        tokenTransfers: [out(AGENT_A, LARGE), out(AGENT_A, LARGE), out(AGENT_A, LARGE)],
      },
    ]);

    expect(events(db)).toHaveLength(1);
    expect(redis.publishes).toHaveLength(1);
  });

  it('records a failed_tx anomaly for an active policy', async () => {
    db.lookupRows = [{ agentAddress: AGENT_A, holderAddress: HOLDER, policyId: 1, state: PolicyState.Active }];

    await monitor.processWebhook([
      {
        signature: 'sig-failed',
        transactionError: { InstructionError: [0, 'Custom'] },
        tokenTransfers: [out(AGENT_A, 10)],
      },
    ]);

    expect(events(db)).toHaveLength(1);
    const row = events(db)[0]!;
    expect(row.eventType).toBe('failed_tx');
    expect(row.severity).toBe('warning');
  });

  it('processes only the agent(s) with Active policy when multiple addresses appear', async () => {
    db.lookupRows = [
      { agentAddress: AGENT_A, holderAddress: HOLDER, policyId: 1, state: PolicyState.Active },
      { agentAddress: AGENT_B, holderAddress: HOLDER, policyId: 2, state: PolicyState.Expired },
    ];

    await monitor.processWebhook([
      {
        signature: 'sig-mixed',
        tokenTransfers: [out(AGENT_A, LARGE), out(AGENT_B, LARGE)],
      },
    ]);

    expect(events(db)).toHaveLength(1);
    const row = events(db)[0]!;
    expect(row.agentAddress).toBe(AGENT_A);
    expect(redis.counters['covantic:metrics:monitor:matched:active']).toBe(1);
    expect(redis.counters['covantic:metrics:monitor:skipped:inactive_policy']).toBe(1);
  });

  it('counts per-transaction errors and continues the batch', async () => {
    db.lookupRows = [{ agentAddress: AGENT_A, holderAddress: HOLDER, policyId: 1, state: PolicyState.Active }];

    // Each transaction issues two queries: the policy lookup, then the
    // balance-baseline read. The baseline read is deliberately fail-safe —
    // detection must not stop because a baseline is missing — so the only
    // query whose failure aborts a transaction is the policy lookup. Throw on
    // the second transaction's, which is the third query overall.
    const QUERIES_PER_TX = 2;
    let queryCount = 0;
    db.onQuery = () => {
      queryCount += 1;
      if (queryCount === QUERIES_PER_TX + 1) throw new Error('DB offline');
    };

    await monitor.processWebhook([
      {
        signature: 'sig-ok',
        tokenTransfers: [out(AGENT_A, LARGE)],
      },
      {
        signature: 'sig-boom',
        tokenTransfers: [out(AGENT_A, LARGE)],
      },
    ]);

    expect(events(db)).toHaveLength(1); // only the first survived
    expect(redis.counters['covantic:metrics:monitor:error:tx']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Oracle deviation screening
// ---------------------------------------------------------------------------

const DEX_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

function mkPriceOracle(price: number): PriceOracle {
  return {
    async getPriceWindow(feedKey: string, targetTime: number): Promise<PriceWindow | null> {
      if (feedKey !== 'SOL/USD') return null;
      const anchor = {
        value: price,
        conf: 0,
        publishTime: targetTime,
        slot: 1,
        source: 'consensus' as const,
        feedId: feedKey,
        raw: null,
      };
      return {
        feedId: feedKey,
        source: 'consensus',
        targetTime,
        before: anchor,
        after: anchor,
        anchor,
        skewSec: 0,
        contributors: [anchor],
        dispersion: 0,
        sourceCount: 4,
      };
    },
  };
}

/** A DEX swap by the agent: pays `usdc`, receives 1 SOL. */
function swapWebhookTx(agent: string, usdc: number) {
  return {
    signature: 'sig-swap',
    timestamp: 1_700_000_000,
    fee: 5_000,
    feePayer: agent,
    transactionError: null,
    instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
    tokenTransfers: [{ fromUserAccount: agent, tokenAmount: usdc }],
    accountData: [
      {
        account: 'ata1',
        nativeBalanceChange: 0,
        tokenBalanceChanges: [
          {
            mint: USDC_MINT,
            rawTokenAmount: { tokenAmount: String(-usdc * 1e6), decimals: 6 },
            userAccount: agent,
          },
        ],
      },
      {
        account: 'ata2',
        nativeBalanceChange: 0,
        tokenBalanceChanges: [
          {
            mint: WRAPPED_SOL,
            rawTokenAmount: { tokenAmount: '1000000000', decimals: 9 },
            userAccount: agent,
          },
        ],
      },
      { account: agent, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
    ],
  };
}

describe('TransactionMonitor — oracle deviation screening', () => {
  let db: FakeDb;
  let redis: FakeRedis;

  beforeEach(() => {
    db = makeFakeDb([{ agentAddress: AGENT_A, holderAddress: HOLDER, policyId: 1, state: PolicyState.Active }]);
    redis = makeFakeRedis();
  });

  function monitorWith(price: number): TransactionMonitor {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new TransactionMonitor(db as any, redis as any, ALERT_SECRET, mkPriceOracle(price));
  }

  it('raises oracle_deviation for a swap filled off the reference', async () => {
    // Before this screen existed, `oracle_deviation` was produced by nothing
    // in production — the demo endpoint was its only source.
    await monitorWith(200).processWebhook([swapWebhookTx(AGENT_A, 250)]);

    const types = db.inserted.map((i) => (i.values as Record<string, unknown>).eventType);
    expect(types).toContain('oracle_deviation');
  });

  it('files the manipulation classification ahead of the size alert', async () => {
    // A large swap trips both detectors, but a policy holds only one open
    // claim. Filing it as `large_transfer` routes it to a verifier that
    // rejects DEX trades outright, and the price evidence is never examined.
    await monitorWith(200).processWebhook([swapWebhookTx(AGENT_A, 2_500)]);

    const types = db.inserted.map((i) => (i.values as Record<string, unknown>).eventType);
    expect(types).toContain('large_transfer');
    expect(types[0]).toBe('oracle_deviation');
  });

  it('stays quiet when the swap was filled at the reference', async () => {
    await monitorWith(250).processWebhook([swapWebhookTx(AGENT_A, 250)]);
    const types = db.inserted.map((i) => (i.values as Record<string, unknown>).eventType);
    expect(types).not.toContain('oracle_deviation');
  });

  it('screens nothing when no price oracle is wired in', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const monitor = new TransactionMonitor(db as any, redis as any, ALERT_SECRET);
    await monitor.processWebhook([swapWebhookTx(AGENT_A, 250)]);
    const types = db.inserted.map((i) => (i.values as Record<string, unknown>).eventType);
    expect(types).not.toContain('oracle_deviation');
  });

  it('leaves an uninsured agent alone', async () => {
    db.lookupRows = [];
    await monitorWith(200).processWebhook([swapWebhookTx(AGENT_B, 250)]);
    expect(events(db)).toHaveLength(0);
  });
});
