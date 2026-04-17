import { describe, it, expect } from 'vitest';

/**
 * End-to-end smoke test for the Covantic API.
 *
 * Requires the API + Docker (Postgres/Redis) to be running, and an agent
 * address populated in the DB. Gated behind COVANTIC_E2E=1 so it stays
 * out of the default `vitest run --passWithNoTests` CI path.
 *
 * Run: `pnpm --filter api test:e2e`
 */
const API_URL = process.env.COVANTIC_API_URL ?? 'http://localhost:4099';
const DEMO_AGENT =
  process.env.COVANTIC_DEMO_AGENT ?? '7nYBm3hXGDFQGfTXvbVwHJCmKxXJEATBGVK7FvCGVzDr';

const runE2E = process.env.COVANTIC_E2E === '1';
const itE2E = runE2E ? it : it.skip;

describe('Covantic E2E', () => {
  itE2E('assesses risk for a devnet agent', async () => {
    const res = await fetch(`${API_URL}/api/risk/${DEMO_AGENT}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tier).toBeGreaterThanOrEqual(0);
    expect(data.score).toBeGreaterThanOrEqual(0);
  });

  itE2E('returns a premium quote (tier derived from fresh assessment)', async () => {
    // Quote now requires a recent assessment — prime the cache first.
    const assessRes = await fetch(`${API_URL}/api/risk/${DEMO_AGENT}`);
    expect(assessRes.status).toBe(200);
    const assessment = await assessRes.json();

    const res = await fetch(`${API_URL}/api/policies/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coverageAmount: 100_000_000,
        durationSeconds: 86400,
        agentAddress: DEMO_AGENT,
      }),
    });

    if (assessment.tier === 3) {
      // EXTREME agent — quote endpoint must refuse.
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('AGENT_UNINSURABLE');
      return;
    }

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.premiumAmount).toBeGreaterThan(0);
    expect(data.riskTier).toBe(assessment.tier);
    expect(typeof data.validUntil).toBe('string');
    expect(typeof data.assessmentId).toBe('string');
  });

  itE2E('lists claims', async () => {
    const res = await fetch(`${API_URL}/api/claims`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.claims)).toBe(true);
  });

  itE2E('returns vault stats', async () => {
    const res = await fetch(`${API_URL}/api/vault/stats`);
    expect(res.status).toBe(200);
  });

  itE2E('returns staking position (zeros for unknown address)', async () => {
    const res = await fetch(
      `${API_URL}/api/staking/${DEMO_AGENT}`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.amountStaked).toBe('number');
  });
});
