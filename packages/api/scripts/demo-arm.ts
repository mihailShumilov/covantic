/**
 * Prepare a policy that is ready to be broken on stage.
 *
 * Usage:
 *   pnpm demo:arm                       # one policy, 7 days
 *   pnpm demo:arm --count 3 --days 30   # three, for a session with retries
 *
 * ## Why arming is a separate step, and cannot not be
 *
 * The obvious demo — buy a policy, break it, watch it pay, all in a minute —
 * is impossible here, and it is impossible on purpose.
 *
 * An agent error is a loss the agent caused with its *own* authority. Every
 * forensic trace says the agent meant it, because it did; nothing in the
 * transaction separates a mistake from a decision. What separates them is what
 * the holder expected, and that is not a fact about the transaction. So the
 * holder declares the envelope in advance, and the verdict is a comparison
 * against their own statement.
 *
 * `MANDATE_DECLARATION_DELAY` is what makes that statement worth anything: the
 * program refuses a declaration that had not matured *before the claim was
 * filed*. Without the hour, a holder could watch a loss happen and then draw
 * the line around it — manufacturing a claim after the fact, which is the one
 * thing this trigger exists to prevent. The delay is not a limitation to work
 * around in a demo. It is the product.
 *
 * So: arm ahead of time, and present the declaration as what it is — the
 * commitment made when the agent was onboarded.
 *
 * A policy also pays exactly once. Settling moves it to `ClaimPaid` and the
 * sweep stops examining it, so each run consumes one. Arm a spare.
 */

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const API = process.env.API_URL ?? 'https://covantic.org';

/** The envelope. Every dimension is declared, and that is deliberate: a
 *  dimension left silent is reported `unevaluated`, and each one costs 0.03 of
 *  the confidence the payout lane needs. A sparse declaration lands at 0.63
 *  against a 0.75 bar and goes to a human — correctly. */
const MAX_SINGLE = '100';
const MAX_WINDOW = '150';
const WINDOW_SEC = '3600';
const MIN_RETAINED = '4600';
/** The sink `agent:trigger` sends to by default, declared so the counterparty
 *  check runs and passes rather than reporting unevaluated. */
const COUNTERPARTY = '8SUV2eNzyrWfyZod1StCSuyBBTk5jruFydaMe8yRyLVC';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Movements that give the agent a history. Below every cap, so none of them
 *  is a breach; `MIN_OUTFLOW_OBSERVATIONS` is 5, and without a baseline the
 *  verdict carries a standing -0.03. */
const HISTORY_TRANSFERS = 6;
const HISTORY_AMOUNT = '20';
/** Spaced past one sweep, so each is seen and recorded separately. */
const HISTORY_GAP_MS = 25_000;

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function run(script: string, args: string[]): string {
  const result = spawnSync('pnpm', ['exec', 'tsx', resolve(import.meta.dirname, script), ...args], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, API_URL: API },
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) {
    process.stdout.write(out);
    throw new Error(`${script} exited ${result.status ?? 'unknown'}`);
  }
  return out;
}

function fleetSize(): number {
  const manifest = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'keys/fleet.json'), 'utf8'),
  ) as { agents?: unknown[] };
  return manifest.agents?.length ?? 0;
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function armOne(days: string): Promise<{ policyId: string; agent: string; readyAt: string }> {
  const before = fleetSize();

  say('  buying a policy…');
  const bought = run('fleet-bootstrap.ts', [
    '--count', String(before + 1),
    '--coverage', '2000',
    '--duration', String(Number(days) * 86_400),
  ]);
  const policyId = /policy #(\d+) bought/.exec(bought)?.[1];
  const agent = /→ (fleet-[a-z0-9-]+)/.exec(bought)?.[1];
  if (!policyId || !agent) {
    process.stdout.write(bought);
    throw new Error('could not tell which policy was bought');
  }
  say(`  policy #${policyId} for ${agent}`);

  say('  declaring the envelope…');
  const declared = run('declare-agent-mandate.ts', [
    '--policy', policyId,
    '--max-single', MAX_SINGLE,
    '--max-window', MAX_WINDOW,
    '--window', WINDOW_SEC,
    '--min-retained', MIN_RETAINED,
    '--counterparty', COUNTERPARTY,
    '--program', TOKEN_PROGRAM,
    '--keypair', 'keys/fleet-holder.json',
  ]);
  const readyAt = /Usable as proof from (\S+)/.exec(declared)?.[1] ?? '(unknown)';

  say(`  giving the agent a history (${HISTORY_TRANSFERS} movements inside the envelope)…`);
  for (let i = 0; i < HISTORY_TRANSFERS; i += 1) {
    run('agent-wallet.ts', ['trigger', '--name', agent, '--amount', HISTORY_AMOUNT, '--kind', 'transfer']);
    if (i < HISTORY_TRANSFERS - 1) {
      await new Promise((r) => setTimeout(r, HISTORY_GAP_MS));
    }
  }

  return { policyId, agent, readyAt };
}

async function main(): Promise<void> {
  const count = Number(flag('count', '1'));
  const days = flag('days', '7');

  say(`Arming ${count} polic${count === 1 ? 'y' : 'ies'} against ${API}\n`);
  const armed: Array<{ policyId: string; agent: string; readyAt: string }> = [];
  for (let i = 0; i < count; i += 1) {
    say(`[${i + 1}/${count}]`);
    armed.push(await armOne(days));
    say('');
  }

  say('Ready to present:\n');
  for (const a of armed) {
    say(`  pnpm demo:autonomous --policy ${a.policyId} --agent ${a.agent} --amount 600`);
    say(`    usable from ${a.readyAt}`);
  }
  say('');
  say('The declaration matures an hour after it lands, and that hour is the');
  say('mechanism rather than a wait: a mandate the holder could declare *after*');
  say('watching a loss would prove nothing. Arm before the room fills.');
  say('');
  say('Each policy pays once — settling closes it. Arm a spare.');
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
