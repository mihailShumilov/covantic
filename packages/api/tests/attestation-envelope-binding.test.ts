import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

  it('rethrows anything that is not that', () => {
    // A blanket retry would turn an oracle with no SOL, or a paused protocol,
    // into a migration attempt followed by the same failure — twice the
    // transactions and the same outcome, with the real cause buried.
    expect(publisher).toMatch(/if \(!isUndersizedAccount\(err\)\) throw err;/);
  });
});
