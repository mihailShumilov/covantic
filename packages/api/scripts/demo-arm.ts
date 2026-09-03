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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const API = process.env.API_URL ?? 'https://covantic.org';

/** The envelope. Every dimension is declared, and that is deliberate: a
 *  dimension left silent is reported `unevaluated`, and each one costs 0.03 of
 *  the confidence the payout lane needs. A sparse declaration lands at 0.63
 *  against a 0.75 bar and goes to a human — correctly. */

/**
 * What the agent is funded with, and why it is not the fleet default of 5000.
 *
 * The envelope now costs what it exposes: the flat premium is what the holder
 * could walk the agent over the line for, which is `balance - cap`. Fund the
 * agent with 5000 under a 100 cap and the envelope alone costs 4900 — capped
 * at the coverage, so the policy costs the entire 2000 it insures. That is the
 * correct price for that shape and a terrible thing to put in front of anyone.
 *
 * 800 leaves 700 exposed, so the policy costs 700 to insure 2000, and after
 * the six history movements the agent still holds 680 — enough to make the
 * 600 the demo asks of it.
 */
const FUND = '800';
/** The sink `agent:trigger` sends to by default, declared so the counterparty
 *  check runs and passes rather than reporting unevaluated. */
const COUNTERPARTY = '8SUV2eNzyrWfyZod1StCSuyBBTk5jruFydaMe8yRyLVC';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** What the demo movement costs the agent. An agent holding less than this
 *  cannot make it, so it cannot breach the envelope either — and cover bought
 *  for it produces a claim that finds no movement to judge. */
const BREACH_AMOUNT = 600;

/** Movements that give the agent a history. Below every cap, so none of them
 *  is a breach; `MIN_OUTFLOW_OBSERVATIONS` is 5, and without a baseline the
 *  verdict carries a standing -0.03. */
const HISTORY_TRANSFERS = 6;
const HISTORY_AMOUNT = '20';
/**
 * Where the quote will put the cap.
 *
 * Not a setting any more: the envelope is derived as five times what the agent
 * ordinarily moves, and the history above is what makes that number 20. So the
 * cap lands at 100, and the 600 the demo asks for is six times over it.
 */
const DERIVED_CAP = Number(HISTORY_AMOUNT) * 5;
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

/** Like `run`, but hands back a failure instead of throwing on one. */
function tryRun(script: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('pnpm', ['exec', 'tsx', resolve(import.meta.dirname, script), ...args], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, API_URL: API },
  });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
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

/**
 * The armed policies, and when each becomes usable.
 *
 * A file rather than a chain read, because the question it answers is "what
 * did we prepare", which is local knowledge. Whether a policy is still
 * *spendable* is not — that comes from the API below, since a demo consumes
 * the policy it runs on and a week later they expire.
 */
const LEDGER = resolve(REPO_ROOT, 'keys/demo-armed.json');

/**
 * Agents the quote has refused this envelope for, so it is not asked twice.
 *
 * A refusal is permanent: it means the agent's ordinary movement has grown
 * past the cap, and its history only ever grows. Without this, every arming
 * spends a quote round-trip rediscovering the same answer about the same
 * agent.
 */
const REFUSED = resolve(REPO_ROOT, 'keys/demo-uninsurable.json');

function readRefused(): string[] {
  if (!existsSync(REFUSED)) return [];
  try {
    return JSON.parse(readFileSync(REFUSED, 'utf8')) as string[];
  } catch {
    return [];
  }
}

function rememberRefused(name: string): void {
  const all = readRefused();
  if (all.includes(name)) return;
  writeFileSync(REFUSED, `${JSON.stringify([...all, name], null, 2)}\n`);
}

interface Armed {
  policyId: string;
  agent: string;
  readyAt: string;
}

function readLedger(): Armed[] {
  if (!existsSync(LEDGER)) return [];
  try {
    return JSON.parse(readFileSync(LEDGER, 'utf8')) as Armed[];
  } catch {
    return [];
  }
}

function appendLedger(entry: Armed): void {
  writeFileSync(LEDGER, `${JSON.stringify([...readLedger(), entry], null, 2)}\n`);
}

const USDC_MINT = process.env.USDC_MINT ?? '';
const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

type State = 'ready' | 'maturing' | 'spent';

/**
 * What the demo movement will actually pay out.
 *
 * Two bounds, and the second is the one that bites. The breach is everything
 * past the derived cap — the first slice is the deductible. But an agent-error
 * settlement may not exceed the premium the policy was bought for, and with
 * the envelope no longer carrying a flat charge, that premium is a rate on the
 * cover for a term.
 *
 * So this trigger returns roughly what it cost, and no more. That is the
 * bound working rather than failing: an agent does what its holder tells it,
 * so a holder paid more than they paid in is holding a withdrawal slip. It
 * is printed rather than left to be discovered on stage.
 */
function expectedPayoutUsdc(premiumPaidRaw: number): number {
  const breach = BREACH_AMOUNT - DERIVED_CAP;
  return Math.min(breach, premiumPaidRaw / 1_000_000);
}

interface FleetAgent {
  name: string;
  pubkey: string;
}

function fleetAgents(): FleetAgent[] {
  const manifest = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'keys/fleet.json'), 'utf8'),
  ) as { agents?: FleetAgent[] };
  return manifest.agents ?? [];
}

/**
 * Covered-mint balance, in whole USDC. Zero when the agent has no account,
 * `null` when the balance could not be read.
 *
 * The two must not collapse into each other. A rate-limited RPC answers
 * without a `result`, and reading that as zero makes a well-funded agent look
 * empty — which passes the "at or below the funding level" test and buys it
 * cover priced on a balance nobody checked. Policy #50 cost 2,000.96 to insure
 * 2,000 that way: the agent held 3,629, the read failed, and the envelope was
 * priced on what it actually had.
 */
async function usdcBalance(owner: string): Promise<number | null> {
  if (!USDC_MINT) return null;
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenAccountsByOwner',
      params: [owner, { mint: USDC_MINT }, { encoding: 'jsonParsed' }],
    }),
  });
  const body = (await res.json()) as {
    result?: { value?: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }> };
  };
  if (body.result?.value === undefined) return null;
  return body.result.value[0]?.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
}

/**
 * Agents a policy can be bought for right now, in the UI.
 *
 * "Right now" means no *active* policy already names them. The exclusion is
 * not tidiness: the sweep resolves an agent to its policy with
 * `state = Active … limit 1`, so a second live policy on the same agent makes
 * which one settles a matter of row order.
 *
 * Balance matters too. An agent with nothing to lose cannot breach an
 * envelope, and a demo that buys cover for an empty wallet ends in a claim
 * that finds no movement.
 */
async function insurable(): Promise<Array<FleetAgent & { usdc: number }>> {
  const res = await fetch(`${API}/api/policies`);
  const body = (await res.json()) as {
    policies?: Array<{ agentAddress: string; state: number }>;
  };
  const covered = new Set(
    (body.policies ?? []).filter((p) => p.state === 0).map((p) => p.agentAddress),
  );

  const free = fleetAgents().filter((a) => !covered.has(a.pubkey));
  return Promise.all(free.map(async (a) => ({ ...a, usdc: await usdcBalance(a.pubkey) })));
}

/** Live state of every armed policy. `spent` covers both outcomes that end a
 *  policy: a demo that settled it, and a week going by. */
async function survey(): Promise<
  Array<Armed & { state: State; premiumUsdc: number; payoutUsdc: number }>
> {
  const res = await fetch(`${API}/api/policies`);
  const body = (await res.json()) as {
    policies?: Array<{ policyId: number; state: number; premiumPaid: number }>;
  };
  const live = new Map(
    (body.policies ?? []).map((p) => [String(p.policyId), p] as const),
  );
  const now = Date.now();

  return readLedger().map((a) => {
    const chain = live.get(a.policyId);
    return {
      ...a,
      premiumUsdc: (chain?.premiumPaid ?? 0) / 1_000_000,
      payoutUsdc: expectedPayoutUsdc(chain?.premiumPaid ?? 0),
      state: (chain === undefined || chain.state !== 0
        ? 'spent'
        : Date.parse(a.readyAt) <= now
          ? 'ready'
          : 'maturing') as State,
    };
  });
}

async function armOne(days: string): Promise<{ policyId: string; agent: string; readyAt: string }> {
  const before = fleetSize();

  // Reuse an uninsured agent before making another.
  //
  // The fleet is capped at twenty, and every failed arming leaves a funded
  // agent behind with no policy on it — so without this the cap fills up with
  // exactly the agents that should have been reused, and arming stops.
  //
  // Only one at or below the funding level qualifies: `ensureUsdc` tops up to
  // a target and never down, and the envelope is priced on what the agent
  // holds. Reusing a 5000 USDC agent under a 100 cap would price the policy at
  // the whole coverage.
  //
  // And never one that has already been through this. The demo movement is six
  // times the cap, so once an agent has made it, that movement *is* its
  // ordinary behaviour, and the quote refuses the envelope outright with
  // `declared_cap_below_agent_normal_movement` — the pricing being right
  // rather than a bug to route around.
  //
  // The ledger knows only what this script armed, so it cannot be the test: an
  // agent broken by hand, or by an older version of this script, is missing
  // from it and looks reusable. The quote is the authority on whether an agent
  // can be insured under this envelope, so ask it, and move to the next
  // candidate when it says no.
  const used = new Set([...readLedger().map((a) => a.agent), ...readRefused()]);
  const spares = (await insurable())
    // `null` is not a small balance. An agent whose balance could not be read
    // is not a candidate, because the envelope would be priced on whatever it
    // turns out to hold.
    .filter((a) => a.usdc !== null && a.usdc <= Number(FUND) && !used.has(a.name))
    .sort((a, b) => (b.usdc ?? 0) - (a.usdc ?? 0));
  // The envelope is bought, not declared afterwards.
  //
  // `create_policy` writes the mandate in the same transaction, because the
  // premium is quoted against it, and a later declaration may only *widen* it
  // — narrowing after the price is fixed is the extraction this all exists to
  // stop. So the two-step arming this script used to do is now refused by the
  // program, and correctly: it bought a wide envelope and then tried to
  // tighten it.
  const common = [
    '--coverage', '600',
    '--duration', String(Number(days) * 86_400),
    '--fund', FUND,
  ];
  // Every reusable agent, then one made for the purpose.
  //
  // The fresh one is created and funded here rather than inside
  // fleet-bootstrap, because it has to behave before it can be underwritten:
  // the cap is five times what the agent ordinarily moves, and bootstrap
  // creates, funds and quotes in one pass with no room for a history in
  // between.
  const fresh = `demo-${Date.now().toString(36)}`;
  const attempts = [
    ...spares.map((a) => ({ label: `buying cover for ${a.name}`, name: a.name, create: false })),
    { label: `buying cover for ${fresh}`, name: fresh, create: true },
  ];

  let bought = '';
  for (const attempt of attempts) {
    let pubkey = fleetAgents().find((c) => c.name === attempt.name)?.pubkey;
    if (attempt.create) {
      say(`  creating ${attempt.name}…`);
      // A fresh agent is not in the fleet manifest yet — `agent:create` writes
      // a keypair and prints the address, and nothing else knows about it
      // until the purchase adds a row.
      pubkey = /Pubkey: (\S+)/.exec(
        run('agent-wallet.ts', ['create', '--name', attempt.name]),
      )?.[1];
      run('agent-wallet.ts', ['fund', '--name', attempt.name, '--usdc', FUND]);
    }
    // The history comes first, and the order is the change.
    //
    // The cap is derived from what the agent ordinarily moves, so an agent
    // with no record gets a cap equal to its balance — one nothing can cross,
    // since it cannot move more than it holds. Buying first and behaving
    // afterwards, which is what this script used to do, produced a policy whose
    // agent-error cover could never fire. An underwriter reads a record; it
    // does not wait for one.
    {
      say(`  ${attempt.name}: ${HISTORY_TRANSFERS} ordinary movements, then underwriting…`);
      for (let i = 0; i < HISTORY_TRANSFERS; i += 1) {
        run('agent-wallet.ts', [
          'trigger', '--name', attempt.name, '--amount', HISTORY_AMOUNT, '--kind', 'transfer',
        ]);
        if (i < HISTORY_TRANSFERS - 1) await new Promise((r) => setTimeout(r, HISTORY_GAP_MS));
      }
      // The quote reads the agent's record, and the record is written by the
      // risk assessment — which is cached for five minutes. Forcing a refresh
      // is what puts the movements above into it before the envelope is drawn
      // from them.
      if (pubkey) {
        await fetch(`${API}/api/risk/${encodeURIComponent(pubkey)}/refresh`, {
          method: 'POST',
        }).catch(() => undefined);
      }
    }
    say(`  ${attempt.label}…`);
    const result = tryRun('fleet-bootstrap.ts', ['--agent', attempt.name, ...common]);
    if (result.ok) {
      bought = result.out;
      break;
    }
    if (result.out.includes('ENVELOPE_NOT_INSURABLE') || result.out.includes('COVERAGE_ABOVE_MAX')) {
      say('    refused — this agent cannot carry the demo envelope');
      rememberRefused(attempt.name);
      continue;
    }
    process.stdout.write(result.out);
    throw new Error('fleet-bootstrap.ts failed');
  }
  if (bought === '') throw new Error('no agent could be insured under the demo envelope');

  const policyId = /policy #(\d+) bought/.exec(bought)?.[1];
  const agent = /→ (fleet-[a-z0-9-]+)/.exec(bought)?.[1];
  if (!policyId || !agent) {
    process.stdout.write(bought);
    throw new Error('could not tell which policy was bought');
  }
  say(`  policy #${policyId} for ${agent}`);

  // Ask the chain when the envelope becomes usable as proof rather than
  // computing it: a `devnet-fast-lock` build compresses the delay to a minute,
  // and the TypeScript constant still says an hour.
  say('  reading the envelope the purchase wrote…');
  const declared = run('declare-agent-mandate.ts', [
    '--policy', policyId,
    '--read',
    '--keypair', 'keys/fleet-holder.json',
  ]);
  const readyAt = /Usable as proof from (\S+)/.exec(declared)?.[1] ?? '(unknown)';

  appendLedger({ policyId, agent, readyAt });
  return { policyId, agent, readyAt };
}

function line(a: Armed): string {
  return `  pnpm demo:autonomous --policy ${a.policyId} --agent ${a.agent} --amount 600`;
}

/** What could be shown right now, and what is on its way. */
async function status(): Promise<void> {
  const all = await survey();
  const ready = all.filter((a) => a.state === 'ready');
  const maturing = all.filter((a) => a.state === 'maturing');

  say(ready.length > 0 ? `READY — ${ready.length} polic${ready.length === 1 ? 'y' : 'ies'}\n` : 'NOTHING READY\n');
  for (const a of ready) say(line(a));
  if (maturing.length > 0) {
    say('\nMaturing:');
    for (const a of maturing) say(`  #${a.policyId} usable from ${a.readyAt}`);
  }
  if (ready.length > 0) {
    say('');
    say('What each will pay, so nothing is a surprise on stage:');
    for (const a of ready) {
      say(
        `  #${a.policyId} premium ${a.premiumUsdc.toFixed(2)} USDC → pays ${a.payoutUsdc.toFixed(2)} USDC`,
      );
    }
    say(
      `  The breach is ${BREACH_AMOUNT - DERIVED_CAP} USDC past the derived cap, and an agent-error`,
    );
    say('  settlement is capped at the premium — an agent does what its holder tells it.');
    say('  The exploit, oracle and governance triggers are not capped and pay the full cover.');
  }
  if (ready.length === 0 && maturing.length === 0) {
    say('Run `pnpm demo:arm` — a declaration must mature before it can be proven against.');
  }

  const free = await insurable();
  // The threshold is what the demo actually spends, not "more than nothing".
  // Three agents from an early fleet hold fractions of a USDC; listing them as
  // insurable invites buying cover for an agent that cannot perform, and the
  // failure would only show up on stage.
  const funded = free
    .filter((a) => a.usdc !== null && a.usdc >= BREACH_AMOUNT)
    .sort((a, b) => (b.usdc ?? 0) - (a.usdc ?? 0));
  const short = free.filter((a) => a.usdc !== null && a.usdc < BREACH_AMOUNT);
  const unread = free.filter((a) => a.usdc === null);

  say('\nInsurable from the UI — no active policy names these:\n');
  if (funded.length === 0) {
    say('  (none — every agent with enough USDC already holds a policy)');
    say('  Prepare one: `pnpm agent:create --name <name>` then `pnpm agent:fund --name <name>`.');
  }
  for (const a of funded) {
    say(`  ${a.pubkey}   ${a.name}   ${(a.usdc ?? 0).toLocaleString()} USDC`);
  }
  if (short.length > 0) {
    const names = short.map((a) => `${a.name} (${(a.usdc ?? 0).toLocaleString()})`).join(', ');
    say(`\n  Below ${BREACH_AMOUNT} USDC, so they cannot make the movement: ${names}.`);
    say('  `pnpm agent:fund --name <name>` tops one up.');
  }
  if (unread.length > 0) {
    // Said out loud rather than folded into the list. An unread balance is not
    // a small one, and the difference decides what a policy costs.
    say(`\n  Balance unreadable (the RPC did not answer): ${unread.map((a) => a.name).join(', ')}.`);
  }
  if (funded.length > 0) {
    say('\nThe envelope is part of the purchase, not a step after it. Set it in the');
    say(`form: cap ${MAX_SINGLE} USDC, floor ${MIN_RETAINED}, counterparty ${COUNTERPARTY},`);
    say(`program ${TOKEN_PROGRAM}. The quote prices it, and it can only be widened`);
    say('afterwards — narrowing it once the price is fixed is what the program refuses.');
    say('');
    say('To read back what a purchase wrote:');
    say('  pnpm --filter api exec tsx scripts/declare-agent-mandate.ts \\');
    say('    --policy <id> --read --keypair keys/fleet-holder.json');
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--status')) {
    await status();
    return;
  }

  const days = flag('days', '7');

  // `--target N` keeps a standing pool: arm only the shortfall.
  //
  // This is the answer to not knowing when the demo happens. A policy pays
  // once and a declaration needs an hour, so "prepare beforehand" fails when
  // beforehand is five minutes' notice. Keeping a few armed at all times costs
  // one scheduled run and preserves the delay that makes the verdict mean
  // something — which shortening it for a demo would not.
  const targetFlag = process.argv.indexOf('--target');
  let count = Number(flag('count', '1'));
  if (targetFlag >= 0) {
    const target = Number(process.argv[targetFlag + 1] ?? '3');
    const standing = (await survey()).filter((a) => a.state !== 'spent').length;
    count = Math.max(0, target - standing);
    say(`${standing} armed or arming, target ${target} — arming ${count}\n`);
    if (count === 0) {
      await status();
      return;
    }
  }

  say(`Arming ${count} polic${count === 1 ? 'y' : 'ies'} against ${API}\n`);
  const armed: Array<{ policyId: string; agent: string; readyAt: string }> = [];
  for (let i = 0; i < count; i += 1) {
    say(`[${i + 1}/${count}]`);
    armed.push(await armOne(days));
    say('');
  }

  say('Ready to present:\n');
  for (const a of armed) {
    say(line(a));
    say(`    usable from ${a.readyAt}`);
  }
  say('');
  say('The envelope matures before it can be proven against, and the delay is the');
  say('mechanism rather than a wait: a mandate the holder could declare *after*');
  say('watching a loss would prove nothing. The exact time above comes from the');
  say('chain — a devnet-fast-lock build compresses an hour to a minute.');
  say('');
  say('`pnpm demo:status` says what is showable right now.');
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
