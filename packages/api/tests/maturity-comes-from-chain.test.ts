import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * INV-MATURITY-01 — when a declaration matures is read, never predicted.
 *
 * `MANDATE_DECLARATION_DELAY_SECONDS` and `GOVERNANCE_BASELINE_DELAY_SECONDS`
 * are TypeScript copies of on-chain constants, and a `devnet-fast-lock` build
 * compresses the on-chain ones to a minute. A script that adds the copy to
 * `Date.now()` then prints an hour for a declaration the program will accept
 * in sixty seconds — telling a policyholder to wait for something that has
 * already happened, on the one screen they consult to find out.
 *
 * The settlement path never had this problem: `MandateReader` and
 * `GovernanceCheckpointWriter` both read `effective_at` off the account and
 * compare it to `claim_submitted_at`. Only the two holder-facing CLIs
 * predicted, which is the half a person actually reads.
 *
 * The general rule is worth keeping: a duplicated constant may describe the
 * chain, but it may not be used to *predict* what the chain has already
 * written down.
 */

const SCRIPTS = ['scripts/declare-agent-mandate.ts', 'scripts/declare-governance-baseline.ts'];
const ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('INV-MATURITY-01 — the declaration CLIs read effective_at', () => {
  it('fetches the account rather than adding the delay to now', () => {
    const offenders: string[] = [];

    for (const file of SCRIPTS) {
      const source = readFileSync(`${ROOT}${file}`, 'utf8').replace(/\/\/.*$/gm, '');
      // The shape of the bug: `Date.now() + <the duplicated constant>`.
      if (/Date\.now\(\)\s*\+\s*\w*DELAY_SECONDS/.test(source)) {
        offenders.push(`${file} — predicts maturity instead of reading it`);
      }
      if (!/effectiveAt\.toNumber\(\)/.test(source)) {
        offenders.push(`${file} — never reads effectiveAt off the account`);
      }
    }

    expect(offenders, 'read effective_at from the account the program wrote').toEqual([]);
  });

  it('leaves the verifiers alone, which already read it', () => {
    // Guards the other direction: if these ever started predicting, a claim
    // could be judged mature against a constant the deployed program does not
    // share — which decides payouts, not just print output.
    for (const file of [
      'src/services/agent-error/mandate.ts',
      'src/services/governance/checkpoint.ts',
    ]) {
      const source = readFileSync(`${ROOT}${file}`, 'utf8');
      expect(source, file).not.toMatch(/Date\.now\(\)\s*\+\s*\w*DELAY_SECONDS/);
      expect(source, file).toMatch(/effectiveAt/);
    }
  });
});
