import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isUndersizedAccount } from '../src/services/attestation-publisher.js';

/**
 * INV-ATTEST-01 — an attestation is identified by the envelope it priced.
 *
 * The tier used to be the whole identity of an attestation, and the publisher
 * reused a live one whenever the tier matched. That stopped being enough the
 * moment the premium started pricing the deductible: the same agent at the
 * same tier can be quoted for two different envelopes, and `create_policy`
 * compares the commitment.
 *
 * Reusing the wrong one is a quiet failure, which is why it is worth pinning.
 * The quote succeeds, the price looks right, and the purchase is rejected by
 * the program with `AttestationMandateMismatch` — a message about a hash, on a
 * screen where the holder chose a number.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const publisher = readFileSync(`${ROOT}src/services/attestation-publisher.ts`, 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

describe('INV-ATTEST-01 — reuse requires the same envelope', () => {
  it('compares the commitment and the price, not only the tier', () => {
    expect(publisher).toMatch(/existing\.mandateHash === wantedHash/);
    expect(publisher).toMatch(/existing\.envelopeFlatPremium === envelopeFlatPremium/);
  });

  it('still requires the tier and the expiry, which reuse always rested on', () => {
    expect(publisher).toMatch(/existing\.tier === tier/);
    expect(publisher).toMatch(/REFRESH_THRESHOLD_SECONDS/);
  });

  it('grows an attestation written before the envelope was priced', () => {
    // `init_if_needed` deserialises an existing account before any constraint
    // could resize it, so an account 34 bytes short is unreadable rather than
    // merely stale. Every agent quoted under the old program has one.
    expect(publisher).toMatch(/migrateAttestation\(\)/);
    expect(publisher).toMatch(/isUndersizedAccount\(err\)/);
  });

  it('recognises the client decoder’s wording, not only the program’s', () => {
    // The message that actually fires, verbatim from production. Anchor reads
    // the account before sending anything, so a struct longer than the buffer
    // throws from Node's DataView — a message with no Solana in it at all. A
    // guard written against the Rust wording alone never ran, because the read
    // threw before the write it was guarding could be attempted.
    expect(
      isUndersizedAccount(
        new RangeError('The value of "offset" is out of range. It must be >= 0 and <= 83. Received 89'),
      ),
    ).toBe(true);

    // And the program's own answer, for when the account does reach it.
    expect(isUndersizedAccount(new Error('AccountDidNotDeserialize'))).toBe(true);
  });

  it('does not treat an ordinary failure as a layout problem', () => {
    // The false positive is the expensive direction: it would answer an empty
    // oracle wallet or a paused protocol with a migration, then fail again
    // with the real cause buried under it.
    for (const other of [
      new Error('Attempt to debit an account but found no record of a prior credit'),
      new Error('ProtocolPaused'),
      new Error('blockhash not found'),
      new Error('429 Too Many Requests'),
    ]) {
      expect(isUndersizedAccount(other), other.message).toBe(false);
    }
  });

  it('grows the account before reading it back, not only before writing', () => {
    // The order matters: the reuse check compares fields it cannot decode
    // from an undersized account, and the write fails on the same account.
    // Migrating on the read path is what makes both work.
    const at = publisher.indexOf("=== 'unreadable'");
    expect(at).toBeGreaterThan(-1);
    expect(publisher).toMatch(/migrateAttestation\(\)/);
  });

  it('rethrows anything that is not that', () => {
    // A blanket retry would turn an oracle with no SOL, or a paused protocol,
    // into a migration attempt followed by the same failure — twice the
    // transactions and the same outcome, with the real cause buried.
    expect(publisher).toMatch(/if \(!isUndersizedAccount\(err\)\) throw err;/);
  });
});
