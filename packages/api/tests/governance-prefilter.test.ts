import { describe, expect, it } from 'vitest';
import { screenRawTxForGovernance } from '../src/services/governance/prefilter.js';
import type { RawTxView } from '../src/services/exploit/raw-tx.js';
import { screenRawTxForExploit } from '../src/services/exploit/prefilter.js';
import {
  AGENT,
  AGENT_PROGRAM_DATA,
  AGENT_USDC_ATA,
  ATTACKER,
  HOLDER,
  OTHER_ATA,
  SQUADS_V4,
  USDC,
  loaderIx,
  opaqueIx,
  rawView,
  tokenIx,
} from './fixtures/governance.js';

function screen(view: RawTxView, baselineAuthorities?: string[]) {
  return screenRawTxForGovernance(view, AGENT, { holderAddress: HOLDER, baselineAuthorities });
}

function view(opts: {
  signers: string[];
  instructions: RawTxView['instructions'];
  postOwner?: string;
  postAmount?: number;
  err?: unknown;
}): RawTxView {
  return rawView({
    keys: [opts.signers[0] ?? AGENT, AGENT, AGENT_USDC_ATA, OTHER_ATA],
    signers: opts.signers,
    err: opts.err,
    pre: [{ account: AGENT_USDC_ATA, mint: USDC, owner: AGENT, amount: 50_000e6, decimals: 6 }],
    post: [
      {
        account: AGENT_USDC_ATA,
        mint: USDC,
        owner: opts.postOwner ?? AGENT,
        amount: opts.postAmount ?? 50_000e6,
        decimals: 6,
      },
    ],
    instructions: opts.instructions,
  });
}

describe('governance screen — fires on takeover shapes', () => {
  it('flags an owner seizure as critical', () => {
    const result = screen(
      view({
        signers: [ATTACKER],
        postOwner: ATTACKER,
        instructions: [
          tokenIx('setAuthority', {
            account: AGENT_USDC_ATA,
            authorityType: 'accountOwner',
            authority: AGENT,
            newAuthority: ATTACKER,
          }),
        ],
      }),
    );

    expect(result.flagged).toBe(true);
    expect(result.severity).toBe('critical');
    expect(result.reason).toBe('account_ownership_seized');
  });

  it('flags a freeze, which no value-based screen can see', () => {
    const result = screen(
      view({
        signers: [ATTACKER],
        instructions: [
          tokenIx('freezeAccount', {
            account: AGENT_USDC_ATA,
            mint: USDC,
            freezeAuthority: ATTACKER,
          }),
        ],
      }),
    );

    expect(result.flagged).toBe(true);
    expect(result.reason).toBe('foreign_freeze_authority');
  });

  it('flags an upgrade-authority handover', () => {
    const result = screen(
      view({
        signers: [AGENT],
        instructions: [
          loaderIx('setAuthority', {
            account: AGENT_PROGRAM_DATA,
            authority: AGENT,
            newAuthority: ATTACKER,
          }),
        ],
      }),
    );

    expect(result.flagged).toBe(true);
    expect(result.reason).toBe('foreign_upgrade_authority');
  });

  it('flags a delegate installation at warning rather than critical', () => {
    const result = screen(
      view({
        signers: [AGENT],
        instructions: [
          tokenIx('approve', {
            source: AGENT_USDC_ATA,
            delegate: ATTACKER,
            owner: AGENT,
            amount: '50000000000',
          }),
        ],
      }),
    );

    expect(result.flagged).toBe(true);
    expect(result.severity).toBe('warning');
    expect(result.reason).toBe('foreign_delegate_authority');
  });

  it('surfaces an opaque multisig program instead of passing it as clean', () => {
    const result = screen(view({ signers: [AGENT], instructions: [opaqueIx(SQUADS_V4)] }));

    expect(result.flagged).toBe(true);
    expect(result.reason).toBe('opaque_control_program');
    expect(result.severity).toBe('warning');
  });
});

describe('governance screen — stays quiet on operations', () => {
  it('ignores a rotation the holder declared as legitimate', () => {
    const operator = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    const result = screen(
      view({
        signers: [HOLDER],
        postOwner: operator,
        instructions: [
          tokenIx('setAuthority', {
            account: AGENT_USDC_ATA,
            authorityType: 'accountOwner',
            authority: AGENT,
            newAuthority: operator,
          }),
        ],
      }),
      [operator],
    );

    expect(result.flagged).toBe(false);
  });

  it('ignores a plain transfer, however large', () => {
    const result = screen(
      view({
        signers: [AGENT],
        postAmount: 0,
        instructions: [
          tokenIx('transfer', {
            source: AGENT_USDC_ATA,
            destination: OTHER_ATA,
            authority: AGENT,
            amount: '50000000000',
          }),
        ],
      }),
    );

    // Draining is the exploit path's business. This screen is about control.
    expect(result.flagged).toBe(false);
  });

  it('ignores a reverted transaction', () => {
    const result = screen(
      view({
        signers: [ATTACKER],
        err: { InstructionError: [0, 'Custom'] },
        postOwner: ATTACKER,
        instructions: [
          tokenIx('setAuthority', {
            account: AGENT_USDC_ATA,
            authorityType: 'accountOwner',
            authority: AGENT,
            newAuthority: ATTACKER,
          }),
        ],
      }),
    );

    expect(result.flagged).toBe(false);
  });
});

describe('governance vs exploit — who owns the seizure', () => {
  /**
   * The reason the watcher screens governance first.
   *
   * Both screens fire on a seizure. Only one of them leads anywhere: the
   * exploit settlement path derives the covered account with
   * `associated_token::authority = policy.agent_address`, which Anchor
   * compiles into an owner equality check — so once the owner has changed,
   * the instruction cannot load the account at all.
   */
  const seizure = view({
    signers: [ATTACKER],
    postOwner: ATTACKER,
    instructions: [
      tokenIx('setAuthority', {
        account: AGENT_USDC_ATA,
        authorityType: 'accountOwner',
        authority: AGENT,
        newAuthority: ATTACKER,
      }),
    ],
  });

  it('both screens fire, which is why the ordering has to be decided', () => {
    expect(screenRawTxForExploit(seizure, AGENT, { holderAddress: HOLDER }).flagged).toBe(true);
    expect(screen(seizure).flagged).toBe(true);
  });

  it('a freeze is seen only by the governance screen', () => {
    const frozen = view({
      signers: [ATTACKER],
      instructions: [
        tokenIx('freezeAccount', {
          account: AGENT_USDC_ATA,
          mint: USDC,
          freezeAuthority: ATTACKER,
        }),
      ],
    });

    expect(screenRawTxForExploit(frozen, AGENT, { holderAddress: HOLDER }).flagged).toBe(false);
    expect(screen(frozen).flagged).toBe(true);
  });
});
