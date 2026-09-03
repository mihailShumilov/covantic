import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * INV-EXTRACT-01 — an agent-error payout never exceeds the premium.
 *
 * This is the one trigger whose actor answers to the claimant. An agent error
 * is a loss the agent caused with its *own* authority, and the agent does what
 * its holder tells it — so a holder paid more than they paid in is holding a
 * withdrawal slip. Move value past the declared cap to an address nothing on
 * chain can attribute to them, and the overshoot comes back from the vault.
 *
 * The premium already prices that: it carries a flat component equal to what
 * the envelope exposed, measured at purchase against the balance the agent
 * held then. What it could not price is what happened next. Top the agent up
 * and the reachable overshoot grows while the premium stays put — the last
 * gap in the pricing, and it does not close by pricing harder, because the
 * price was already set.
 *
 * It closes at the payout, where the balance no longer matters: whatever the
 * agent came to hold, the vault does not pay out more than it took in.
 *
 * Not on the other triggers. Exploit and governance settle losses the holder
 * did not cause and cannot arrange, and capping those at the premium would
 * deny a genuine victim the cover they bought.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PROGRAM = fileURLToPath(new URL('../../anchor/programs/covantic/src/', import.meta.url));

const strip = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('INV-EXTRACT-01 — the vault does not pay out more than it took in', () => {
  it('is enforced by the program, which is the only place it binds', () => {
    const source = strip(readFileSync(`${PROGRAM}instructions/verify_and_payout_agent_error.rs`, 'utf8'));

    expect(source).toMatch(/payout_amount <= policy\.premium_paid/);
  });

  it('is enforced by the keeper too, so no reverting transaction is sent', () => {
    // A reverted payout is recorded, and the record is worse than the
    // shortfall: it reads as a failure of the protocol rather than as a bound
    // working.
    const keeper = strip(readFileSync(`${ROOT}src/workers/claim-keeper.ts`, 'utf8'));

    expect(keeper).toMatch(/Math\.min\(payoutAmount, policy\.premiumPaid\)/);
  });

  it('leaves the exploit path alone', () => {
    const source = strip(readFileSync(`${PROGRAM}instructions/verify_and_payout_exploit.rs`, 'utf8'));

    expect(source).not.toMatch(/premium_paid/);
  });

  it('leaves the governance path alone', () => {
    const source = strip(
      readFileSync(`${PROGRAM}instructions/verify_and_payout_governance.rs`, 'utf8'),
    );

    expect(source).not.toMatch(/premium_paid/);
  });

  it('keeps the coverage bound as well, since neither implies the other', () => {
    // The premium can exceed the coverage on a habit-priced envelope, and the
    // coverage can exceed the premium on a wide one. Both bounds have to hold.
    const source = strip(readFileSync(`${PROGRAM}instructions/verify_and_payout_agent_error.rs`, 'utf8'));

    expect(source).toMatch(/payout_amount <= policy\.coverage_amount/);
  });
});
