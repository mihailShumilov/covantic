/**
 * End-to-end smoke test for the auto-claim pipeline.
 *
 * Preconditions:
 *   - API running locally on $API_URL (default http://localhost:4099), with
 *     all workers enabled (policy indexer + claim keeper).
 *   - At least one ACTIVE InsurancePolicy on-chain; the indexer will have
 *     mirrored it into the `policies` table within ~60s of boot.
 *   - The protocol vault must have USDC deposited (stakers) so the payout
 *     can actually settle; otherwise the keeper will reach 'approved' and
 *     then fail at verify_and_payout with InsufficientVaultBalance.
 *
 * What it does:
 *   1. Pick an ACTIVE policy from /api/policies.
 *   2. Fire POST /api/demo/simulate-exploit for its agent.
 *   3. Poll /api/claims, asserting the claim row progresses to status=paid
 *      and that both submit_tx_signature and payout_tx_signature are set.
 *   4. Print the Solana Explorer URLs so a human can verify on-chain.
 *
 * Usage:
 *   pnpm exec tsx scripts/smoke-auto-claim.ts
 */

const API_URL = process.env.API_URL ?? 'http://localhost:4099';
const NETWORK = process.env.SOLANA_NETWORK ?? 'devnet';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000);
const POLL_INTERVAL_MS = 1_000;

interface Policy {
  policyId: number;
  agentAddress: string;
  state: number;
  holderAddress: string;
  coverageAmount: number;
}

interface Claim {
  id: string;
  policyId: number;
  status: string;
  submitTxSignature: string | null;
  payoutTxSignature: string | null;
  payoutAmount: number | null;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

function explorerUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=${NETWORK}`;
}

async function main() {
  console.log(`[smoke] API: ${API_URL}`);

  // 1. Find an active policy
  const { policies } = await fetchJson<{ policies: Policy[] }>('/api/policies?state=0');
  const policy = policies[0];
  if (!policy) {
    throw new Error('No active policies indexed. Purchase a policy via /dashboard first.');
  }
  console.log(
    `[smoke] Using policy #${policy.policyId} for agent ${policy.agentAddress} (coverage ${policy.coverageAmount} lamports)`,
  );

  // 2. Fire simulated exploit
  const sim = await postJson<{ success: boolean }>('/api/demo/simulate-exploit', {
    agentAddress: policy.agentAddress,
    type: 'exploit',
  });
  console.log('[smoke] Simulated exploit:', sim);

  // 3. Poll for the claim to reach 'paid'
  const start = Date.now();
  let claim: Claim | null = null;
  while (Date.now() - start < TIMEOUT_MS) {
    const { claims } = await fetchJson<{ claims: Claim[] }>(
      `/api/claims?holder=${policy.holderAddress}`,
    );
    claim = claims.find((c) => c.policyId === policy.policyId) ?? null;
    if (claim) {
      console.log(`[smoke] claim ${claim.id} status=${claim.status}`);
      if (claim.status === 'paid') break;
      if (claim.status === 'rejected' || claim.status === 'failed') {
        throw new Error(`Claim terminated in non-success state: ${claim.status}`);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!claim || claim.status !== 'paid') {
    throw new Error(
      `Timed out after ${TIMEOUT_MS}ms waiting for paid status; last status=${claim?.status ?? 'none'}`,
    );
  }

  // 4. Assert tx signatures are present
  if (!claim.submitTxSignature || claim.submitTxSignature.startsWith('demo_')) {
    throw new Error(`submitTxSignature missing or synthetic: ${claim.submitTxSignature}`);
  }
  if (!claim.payoutTxSignature) {
    throw new Error('payoutTxSignature missing');
  }

  console.log(`\n[smoke] PASSED — policy #${policy.policyId} paid ${claim.payoutAmount} lamports`);
  console.log(`  submit  tx: ${explorerUrl(claim.submitTxSignature)}`);
  console.log(`  payout  tx: ${explorerUrl(claim.payoutTxSignature)}`);
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err.message ?? err);
  process.exit(1);
});
