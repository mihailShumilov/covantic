/**
 * Watch one covered agent breach its declared envelope, and time every step.
 *
 * Usage:
 *   pnpm demo:autonomous --policy 25 --agent fleet-mthonktd-3 --amount 600
 *   pnpm demo:autonomous --policy 25 --agent fleet-mthonktd-3 --dry-run
 *
 * ## Why this trigger and not the exploit one
 *
 * The exploit path cannot be demonstrated by anyone holding the agent's key,
 * and that is the point rather than a limitation.
 * `verify_and_payout_exploit` pays on a movement the agent did *not*
 * authorise; only a token account's owner can sign `Approve`, so a delegate
 * staged for a demo resolves to `granted_by_agent` and the claim is rejected.
 * A demo that got a payout there would be a demo of a hole.
 *
 * Agent error is the honest one. The holder declares an operating envelope in
 * advance, the agent exceeds it, and the program re-derives the overshoot from
 * a balance it reads itself. Nothing here is simulated: a real transfer lands
 * on devnet, the sweep finds it from the chain's own record, and the payout is
 * an on-chain instruction that recomputes the amount rather than trusting one.
 *
 * ## What the timer is measuring
 *
 * Setup — buying the policy, declaring the mandate — is deliberately *not*
 * timed. `MANDATE_DECLARATION_DELAY` is an hour, and shortening it would
 * destroy the thing being demonstrated: the declaration has to predate the
 * loss, or it is not a pre-commitment. The clock here starts at the breach.
 *
 * The run needs a program built with `--features devnet-fast-lock`; against a
 * stock build the payout waits out `LOCK_AGENT_ERROR` (six hours) instead,
 * which the keeper handles by deferring rather than failing.
 */

import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

const API = process.env.API_URL ?? 'https://covantic.org';
const POLL_MS = 2_000;
const GIVE_UP_MS = 5 * 60_000;

interface ClaimRow {
  id: string;
  policyId: number;
  status: string;
  triggerType: number;
  /** The transaction the claim was raised for. Returned by /api/claims and read
   *  here to tell this run's claim from any other open one — so leaving it off
   *  the type made the comparison below silently always false. */
  triggerTxSignature?: string | null;
  lossAmount: number | null;
  payoutAmount: number | null;
  payoutTxSignature?: string | null;
  submitTxSignature?: string | null;
  reviewReason?: string | null;
  verificationData?: Record<string, unknown> | null;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const started = Date.now();
function stamp(): string {
  return `t+${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;
}
function say(line: string): void {
  process.stdout.write(`${stamp()}  ${line}\n`);
}

async function claimsFor(policyId: number): Promise<ClaimRow[]> {
  const res = await fetch(`${API}/api/claims?limit=50`);
  if (!res.ok) throw new Error(`GET /api/claims → ${res.status}`);
  const body = (await res.json()) as { claims: ClaimRow[] };
  return body.claims.filter((c) => c.policyId === policyId);
}

async function main(): Promise<void> {
  const policyId = Number(flag('policy') ?? 0);
  const agent = flag('agent');
  const amount = flag('amount') ?? '600';
  const dryRun = process.argv.includes('--dry-run');
  if (!policyId || !agent) {
    throw new Error('Usage: demo:autonomous --policy <id> --agent <name> [--amount 600]');
  }

  // A policy holds one open claim, so a standing one either blocks this run or
  // gets re-pointed at the new transaction. Both are worth following, and
  // watching only for a *new* row misses the second entirely: the keeper
  // supersedes by editing the parked claim in place, so the id does not
  // change. That is how a run that worked end to end reported "no claim
  // reached a terminal state" while the claim it should have watched went to a
  // verdict.
  const before = await claimsFor(policyId);
  if (before.length > 0) {
    say(`note: policy ${policyId} already has ${before.length} claim(s); one may be superseded`);
  }

  say(`agent ${agent} moves ${amount} USDC against a declared cap`);
  if (dryRun) {
    say('dry run — no transaction sent');
    return;
  }

  const sent = spawnSync(
    'pnpm',
    ['exec', 'tsx', resolve(import.meta.dirname, 'agent-wallet.ts'), 'trigger',
     '--name', agent, '--amount', amount, '--kind', 'transfer'],
    { cwd: resolve(import.meta.dirname, '..'), stdio: 'pipe', encoding: 'utf8' },
  );
  if (sent.status !== 0) {
    process.stdout.write(sent.stdout ?? '');
    process.stderr.write(sent.stderr ?? '');
    throw new Error('the transfer did not land; nothing to watch');
  }
  const sig = /([1-9A-HJ-NP-Za-km-z]{80,90})/.exec(sent.stdout ?? '')?.[1];
  say(`transfer landed${sig ? `: ${sig}` : ''}`);

  let seen = '';
  const deadline = Date.now() + GIVE_UP_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));

    const all = await claimsFor(policyId);
    // The claim this run is about is the one pointing at the transaction this
    // run sent — whether it was created for it or re-pointed at it.
    const claim =
      all.find((c) => sig && c.triggerTxSignature === sig) ??
      all.find((c) => !before.some((b) => b.id === c.id));
    if (!claim) continue;

    if (claim.status !== seen) {
      seen = claim.status;
      const detail =
        claim.status === 'paid'
          ? ` — ${((claim.payoutAmount ?? 0) / 1e6).toLocaleString()} USDC`
          : claim.reviewReason
            ? ` — ${claim.reviewReason}`
            : '';
      say(`claim ${claim.id.slice(0, 8)} → ${claim.status}${detail}`);
    }

    if (claim.status === 'paid') {
      say(`payout tx: ${claim.payoutTxSignature ?? '(not recorded)'}`);
      say('The chain re-derived that amount from a balance it read itself.');
      return;
    }
    // `review` and `rejected` are closed for this run's purposes: both are
    // real outcomes, and reporting one as a hang would be the demo lying.
    if (claim.status === 'rejected' || claim.status === 'review') {
      say(`stopped at ${claim.status}. This is a verdict, not a failure to reach one.`);
      return;
    }
  }

  say('no claim reached a terminal state in five minutes');
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
