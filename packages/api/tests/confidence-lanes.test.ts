import { describe, expect, it } from 'vitest';
import { TriggerType } from '@covantic/shared';
import {
  AUTO_PAY_CONFIDENCE,
  REVIEW_CONFIDENCE,
  decideLane,
} from '../src/services/confidence-lanes.js';
import { CONFIDENCE_CEILING as EXPLOIT_CEILING } from '../src/services/exploit/adjudicate.js';
import { CONFIDENCE_CEILING as ORACLE_CEILING } from '../src/services/oracle/adjudicate.js';

describe('confidence lanes', () => {
  it('keeps off-chain analysis structurally unable to release funds alone', () => {
    // The load-bearing property of the whole design. Both adjudicators cap
    // below the auto-pay bar, so paying always needs the chain's own check.
    expect(EXPLOIT_CEILING).toBeLessThan(AUTO_PAY_CONFIDENCE);
    expect(ORACLE_CEILING).toBeLessThan(AUTO_PAY_CONFIDENCE);
  });

  it('pays a well-evidenced exploit only alongside a chain proof', () => {
    const decision = decideLane({
      triggerType: TriggerType.Exploit,
      confidence: EXPLOIT_CEILING,
      proofAvailable: true,
    });

    expect(decision).toEqual({ lane: 'pay', requiresChainProof: true });
  });

  it('sends the same verdict to review when the proof is unavailable', () => {
    // Fails closed: anyone able to stop a proof being built would otherwise
    // get the unverified behaviour back.
    const decision = decideLane({
      triggerType: TriggerType.Exploit,
      confidence: EXPLOIT_CEILING,
      proofAvailable: false,
    });

    expect(decision.lane).toBe('review');
    expect(decision).toMatchObject({ reason: 'proof_path_unavailable' });
  });

  it('reviews anything under the bar regardless of proof', () => {
    // 0.6 is what the old exploit verifier scored its default branch, and it
    // was paid in full because nothing compared it to anything.
    const decision = decideLane({
      triggerType: TriggerType.Exploit,
      confidence: 0.6,
      proofAvailable: true,
    });

    expect(decision.lane).toBe('review');
    expect(REVIEW_CONFIDENCE).toBeGreaterThan(0.6);
  });

  it('names the absence of a proof path distinctly from its failure', () => {
    // A reviewer reading "no_proof_path_for_trigger" learns something
    // different from "proof_path_unavailable" — one is a gap in coverage, the
    // other is an incident.
    //
    // All four declared triggers now have a proof path, so this case is
    // reached only by a trigger value the lanes do not know about. That is
    // worth keeping rather than deleting: the branch is what a *new* trigger
    // lands in before its instruction exists, and it must route to a human
    // rather than defaulting into the pay lane.
    const unknownTrigger = 99;
    const decision = decideLane({
      triggerType: unknownTrigger,
      confidence: 0.8,
      proofAvailable: false,
    });

    expect(decision).toMatchObject({ lane: 'review', reason: 'no_proof_path_for_trigger' });
  });

  it('treats a broken proof path as an incident, not a gap in coverage', () => {
    // The other side of the same fork, for a trigger that *does* have an
    // instruction: proof was possible and could not be produced.
    const decision = decideLane({
      triggerType: TriggerType.AgentError,
      confidence: 0.8,
      proofAvailable: false,
    });

    expect(decision).toMatchObject({ lane: 'review', reason: 'proof_path_unavailable' });
  });

  it('would pay without a proof only above the unreachable bar', () => {
    const decision = decideLane({
      triggerType: TriggerType.Exploit,
      confidence: AUTO_PAY_CONFIDENCE,
      proofAvailable: false,
    });

    expect(decision).toEqual({ lane: 'pay', requiresChainProof: false });
  });
});
