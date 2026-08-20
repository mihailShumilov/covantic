import { describe, expect, it } from 'vitest';
import { evaluateBreach, type BreachInput } from '../src/services/agent-error/breach.js';
import { HOLDER, OTHER_ATA, JUPITER, UNKNOWN_PROGRAM } from './fixtures/exploit.js';
import { MATURE_MANDATE, AMOUNTS_ONLY_MANDATE } from './fixtures/agent-error-corpus.js';

const CAP = MATURE_MANDATE.maxSingleOutflowRaw;
const FLOOR = MATURE_MANDATE.minRetainedBalanceRaw;

function input(partial: Partial<BreachInput> = {}): BreachInput {
  return {
    mandate: MATURE_MANDATE,
    outflowRaw: 100 * 10 ** 6,
    retainedRaw: 5_000 * 10 ** 6,
    windowOutflowRaw: null,
    destinations: [OTHER_ATA],
    programs: [JUPITER],
    ...partial,
  };
}

describe('evaluateBreach — quantitative dimensions', () => {
  it('reports no breach for a movement inside every declared bound', () => {
    const report = evaluateBreach(input());

    expect(report.breached).toBe(false);
    expect(report.excessRaw).toBe(0);
    expect(report.provable).toBe(false);
  });

  it('measures the overshoot past the single-outflow cap', () => {
    const report = evaluateBreach(input({ outflowRaw: CAP + 250 * 10 ** 6 }));

    expect(report.breached).toBe(true);
    expect(report.excessRaw).toBe(250 * 10 ** 6);
    expect(report.provable).toBe(true);
    expect(report.dimensions.map((d) => d.dimension)).toContain('single_outflow');
  });

  it('measures how far below the retention floor the account ended up', () => {
    const report = evaluateBreach(
      input({ outflowRaw: 900 * 10 ** 6, retainedRaw: FLOOR - 100 * 10 ** 6 }),
    );

    const floorDim = report.dimensions.find((d) => d.dimension === 'retained_balance');
    expect(floorDim?.excessRaw).toBe(100 * 10 ** 6);
    expect(report.provable).toBe(true);
  });

  it('never claims a floor breach larger than the movement itself', () => {
    // An account that was already below the declared floor before this
    // transfer must not let the claim reach back for value that left earlier.
    const report = evaluateBreach(input({ outflowRaw: 10 * 10 ** 6, retainedRaw: 0 }));

    const floorDim = report.dimensions.find((d) => d.dimension === 'retained_balance');
    expect(floorDim?.excessRaw).toBe(10 * 10 ** 6);
  });

  it('reports the retention floor as unevaluated when no absolute balance exists', () => {
    const report = evaluateBreach(input({ retainedRaw: null }));

    expect(report.unevaluated.map((u) => u.check)).toContain('retained_balance');
    expect(report.dimensions.map((d) => d.dimension)).not.toContain('retained_balance');
  });

  it('takes the largest chain-checkable overshoot as the bound', () => {
    // Both quantitative dimensions breached; the payout bound is the larger,
    // because that is the number the program will recompute.
    const report = evaluateBreach(
      input({ outflowRaw: CAP + 100 * 10 ** 6, retainedRaw: FLOOR - 400 * 10 ** 6 }),
    );

    expect(report.excessRaw).toBe(400 * 10 ** 6);
  });
});

describe('evaluateBreach — the window cap', () => {
  it('breaches on the cumulative total, but not in a way the chain can check', () => {
    const report = evaluateBreach(
      input({
        outflowRaw: 100 * 10 ** 6,
        windowOutflowRaw: MATURE_MANDATE.maxWindowOutflowRaw + 1,
      }),
    );

    const windowDim = report.dimensions.find((d) => d.dimension === 'window_outflow');
    expect(windowDim?.chainCheckable).toBe(false);
    // The program holds one balance reading per policy, not a window of
    // transfers, so this cannot bound a proven payout.
    expect(report.provable).toBe(false);
    expect(report.excessRaw).toBe(0);
  });

  it('reports the window as unevaluated when there is no history', () => {
    const report = evaluateBreach(input({ windowOutflowRaw: null }));

    expect(report.unevaluated.map((u) => u.check)).toContain('window_outflow');
  });
});

describe('evaluateBreach — silence is not prohibition', () => {
  it('treats an empty counterparty allowlist as undeclared, not as forbidding everything', () => {
    // The failure mode this guards is the retired verifier's, arrived at from
    // the opposite direction: reading a blank field as a universal prohibition
    // would make every ordinary transfer a covered event.
    const report = evaluateBreach(
      input({ mandate: AMOUNTS_ONLY_MANDATE, destinations: [UNKNOWN_PROGRAM] }),
    );

    expect(report.breached).toBe(false);
    expect(report.unevaluated.map((u) => u.check)).toEqual(
      expect.arrayContaining(['counterparty', 'program']),
    );
  });

  it('flags an undeclared destination when the holder did declare a list', () => {
    const report = evaluateBreach(input({ destinations: [UNKNOWN_PROGRAM] }));

    const dim = report.dimensions.find((d) => d.dimension === 'counterparty');
    expect(dim).toMatchObject({ kind: 'categorical', excessRaw: 0, chainCheckable: false });
    expect(report.breached).toBe(true);
    // Real, but not bounded by anything the program can recompute.
    expect(report.provable).toBe(false);
  });

  it('accepts a declared destination', () => {
    const report = evaluateBreach(input({ destinations: [HOLDER] }));

    expect(report.dimensions.map((d) => d.dimension)).not.toContain('counterparty');
  });

  it('flags an undeclared program', () => {
    const report = evaluateBreach(input({ programs: [UNKNOWN_PROGRAM] }));

    expect(report.dimensions.map((d) => d.dimension)).toContain('program');
  });

  it('reports unresolved destinations as unevaluated rather than as compliant', () => {
    const report = evaluateBreach(input({ destinations: [] }));

    expect(report.unevaluated.map((u) => u.check)).toContain('counterparty');
  });
});

describe('evaluateBreach — purity', () => {
  it('returns an identical report for identical input', () => {
    const spec = input({ outflowRaw: CAP * 3, retainedRaw: 0 });

    expect(evaluateBreach(spec)).toEqual(evaluateBreach(spec));
  });
});
