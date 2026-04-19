import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PolicyState } from '@covantic/shared';
import { TransactionMonitor } from '../src/services/transaction-monitor.js';

/**
 * Unit tests for TransactionMonitor.
 *
 * The monitor talks to Drizzle (select / insert) and Redis (incr / publish).
 * Both are stubbed with spy-friendly fakes so we can assert decisions
 * without standing up Postgres. The `db.select(...).from(...).where(...)`
 * chain is the only Drizzle shape the monitor uses, so the fake only
 * implements that chain plus `insert(...).values(...)`.
 */

type PolicyRow = { agentAddress: string; policyId: number; state: number };

interface FakeDb {
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

  db.select.mockImplementation(() => ({
    from: () => ({
      where: async () => db.lookupRows,
    }),
  }));

  db.insert.mockImplementation((table: unknown) => ({
    values: async (values: unknown) => {
      db.inserted.push({ table, values });
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

const ALERT_SECRET = 'test-alert-secret';
const AGENT_A = 'AgentAddressAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const AGENT_B = 'AgentAddressBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// Helius Enhanced Transactions deliver `tokenAmount` as a decimal-aware
// UI amount (e.g. `2000.0` for a 2,000 USDC transfer), matching what the
// monitor compares against. These fixtures mirror that: `LARGE` is just
// above the 1,000 UI threshold and `CRITICAL` just above 10,000.
const LARGE = 2_000;
const CRITICAL = 20_000;
const SUB_THRESHOLD = 500;

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
    db.lookupRows = [{ agentAddress: AGENT_A, policyId: 1, state: PolicyState.Active }];

    await monitor.processWebhook([
      {
        signature: 'sig-active-large',
        tokenTransfers: [{ fromUserAccount: AGENT_A, tokenAmount: LARGE }],
      },
    ]);

    expect(db.inserted).toHaveLength(1);
    const row = db.inserted[0]!.values as Record<string, unknown>;
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
    db.lookupRows = [{ agentAddress: AGENT_A, policyId: 1, state: PolicyState.Active }];

    await monitor.processWebhook([
      {
        signature: 'sig-critical',
        tokenTransfers: [{ fromUserAccount: AGENT_A, tokenAmount: CRITICAL }],
      },
    ]);

    const row = db.inserted[0]!.values as Record<string, unknown>;
    expect(row.severity).toBe('critical');
    expect(redis.counters['covantic:metrics:monitor:anomaly:critical']).toBe(1);
    expect(redis.counters['covantic:metrics:monitor:anomaly:warning'] ?? 0).toBe(0);
  });

  it('skips when the policy exists but is Expired', async () => {
    db.lookupRows = [{ agentAddress: AGENT_A, policyId: 1, state: PolicyState.Expired }];

    await monitor.processWebhook([
      {
        signature: 'sig-expired',
        tokenTransfers: [{ fromUserAccount: AGENT_A, tokenAmount: LARGE }],
      },
    ]);

    expect(db.inserted).toHaveLength(0);
    expect(redis.publishes).toHaveLength(0);
    expect(redis.counters['covantic:metrics:monitor:skipped:inactive_policy']).toBe(1);
    expect(redis.counters['covantic:metrics:monitor:matched:active'] ?? 0).toBe(0);
  });

  it('skips when the policy is ClaimPending (not Active)', async () => {
    db.lookupRows = [{ agentAddress: AGENT_A, policyId: 1, state: PolicyState.ClaimPending }];

    await monitor.processWebhook([
      {
        signature: 'sig-claim-pending',
        tokenTransfers: [{ fromUserAccount: AGENT_A, tokenAmount: LARGE }],
      },
    ]);

    expect(db.inserted).toHaveLength(0);
    expect(redis.counters['covantic:metrics:monitor:skipped:inactive_policy']).toBe(1);
  });

  it('skips an uninsured agent and counts it distinctly', async () => {
    db.lookupRows = []; // no rows for this agent

    await monitor.processWebhook([
      {
        signature: 'sig-uninsured',
        tokenTransfers: [{ fromUserAccount: AGENT_A, tokenAmount: LARGE }],
      },
    ]);

    expect(db.inserted).toHaveLength(0);
    expect(redis.counters['covantic:metrics:monitor:skipped:uninsured']).toBe(1);
    expect(redis.counters['covantic:metrics:monitor:skipped:inactive_policy'] ?? 0).toBe(0);
  });

  it('does nothing when a webhook carries no fromUserAccount addresses', async () => {
    db.lookupRows = [];

    await monitor.processWebhook([
      { signature: 'sig-empty', tokenTransfers: [] },
    ]);

    expect(db.inserted).toHaveLength(0);
    expect(redis.publishes).toHaveLength(0);
    expect(redis.counters['covantic:metrics:monitor:skipped:no_addresses']).toBe(1);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('does not flag a sub-threshold transfer as anomalous', async () => {
    db.lookupRows = [{ agentAddress: AGENT_A, policyId: 1, state: PolicyState.Active }];

    await monitor.processWebhook([
      {
        signature: 'sig-small',
        tokenTransfers: [{ fromUserAccount: AGENT_A, tokenAmount: SUB_THRESHOLD }],
      },
    ]);

    expect(db.inserted).toHaveLength(0);
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
    db.lookupRows = [{ agentAddress: AGENT_A, policyId: 1, state: PolicyState.Active }];

    await monitor.processWebhook([
      {
        signature: 'sig-real-helius',
        tokenTransfers: [{ fromUserAccount: AGENT_A, tokenAmount: 2_000 }],
      },
    ]);

    expect(db.inserted).toHaveLength(1);
    const row = db.inserted[0]!.values as Record<string, unknown>;
    expect(row.eventType).toBe('large_transfer');
    const details = row.details as { amountUi?: number };
    expect(details.amountUi).toBe(2_000);
    expect(redis.counters['covantic:metrics:monitor:anomaly:warning']).toBe(1);
  });

  it('records a failed_tx anomaly for an active policy', async () => {
    db.lookupRows = [{ agentAddress: AGENT_A, policyId: 1, state: PolicyState.Active }];

    await monitor.processWebhook([
      {
        signature: 'sig-failed',
        transactionError: { InstructionError: [0, 'Custom'] },
        tokenTransfers: [{ fromUserAccount: AGENT_A, tokenAmount: 10 }],
      },
    ]);

    expect(db.inserted).toHaveLength(1);
    const row = db.inserted[0]!.values as Record<string, unknown>;
    expect(row.eventType).toBe('failed_tx');
    expect(row.severity).toBe('warning');
  });

  it('processes only the agent(s) with Active policy when multiple addresses appear', async () => {
    db.lookupRows = [
      { agentAddress: AGENT_A, policyId: 1, state: PolicyState.Active },
      { agentAddress: AGENT_B, policyId: 2, state: PolicyState.Expired },
    ];

    await monitor.processWebhook([
      {
        signature: 'sig-mixed',
        tokenTransfers: [
          { fromUserAccount: AGENT_A, tokenAmount: LARGE },
          { fromUserAccount: AGENT_B, tokenAmount: LARGE },
        ],
      },
    ]);

    expect(db.inserted).toHaveLength(1);
    const row = db.inserted[0]!.values as Record<string, unknown>;
    expect(row.agentAddress).toBe(AGENT_A);
    expect(redis.counters['covantic:metrics:monitor:matched:active']).toBe(1);
    expect(redis.counters['covantic:metrics:monitor:skipped:inactive_policy']).toBe(1);
  });

  it('counts per-transaction errors and continues the batch', async () => {
    db.lookupRows = [{ agentAddress: AGENT_A, policyId: 1, state: PolicyState.Active }];

    // Force the second transaction to throw inside processTransaction by
    // having the select path blow up on that call.
    let callCount = 0;
    db.select.mockImplementation(() => ({
      from: () => ({
        where: async () => {
          callCount += 1;
          if (callCount === 2) throw new Error('DB offline');
          return db.lookupRows;
        },
      }),
    }));

    await monitor.processWebhook([
      {
        signature: 'sig-ok',
        tokenTransfers: [{ fromUserAccount: AGENT_A, tokenAmount: LARGE }],
      },
      {
        signature: 'sig-boom',
        tokenTransfers: [{ fromUserAccount: AGENT_A, tokenAmount: LARGE }],
      },
    ]);

    expect(db.inserted).toHaveLength(1); // only the first survived
    expect(redis.counters['covantic:metrics:monitor:error:tx']).toBe(1);
  });
});
