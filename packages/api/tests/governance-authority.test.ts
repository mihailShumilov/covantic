import { describe, expect, it } from 'vitest';
import { analyseAuthority, hasForeignTakeover } from '../src/services/governance/authority.js';
import type { RawTxView } from '../src/services/exploit/raw-tx.js';
import {
  AGENT,
  AGENT_PROGRAM_DATA,
  AGENT_USDC_ATA,
  ATTACKER,
  HOLDER,
  HOLDER_SECOND_WALLET,
  OTHER_ATA,
  SQUADS_V4,
  USDC,
  loaderIx,
  opaqueIx,
  rawView,
  tokenIx,
} from './fixtures/governance.js';

function analyse(view: RawTxView) {
  return analyseAuthority({ view, agentAddress: AGENT, holderAddress: HOLDER });
}

/** The agent's USDC ATA, unchanged in balance unless a test says otherwise. */
function controlView(opts: {
  signers: string[];
  instructions: RawTxView['instructions'];
  postOwner?: string;
}): RawTxView {
  return rawView({
    keys: [opts.signers[0] ?? AGENT, AGENT, AGENT_USDC_ATA, OTHER_ATA],
    signers: opts.signers,
    pre: [{ account: AGENT_USDC_ATA, mint: USDC, owner: AGENT, amount: 50_000e6, decimals: 6 }],
    post: [
      {
        account: AGENT_USDC_ATA,
        mint: USDC,
        owner: opts.postOwner ?? AGENT,
        amount: 50_000e6,
        decimals: 6,
      },
    ],
    instructions: opts.instructions,
  });
}

describe('authority forensics — the shapes a transfer-shaped view cannot see', () => {
  it('reads an owner seizure from the balance snapshots alone', () => {
    // No decoded instruction at all: an opaque program reassigned the account
    // through a CPI the RPC never parsed. The snapshots still show it.
    const report = analyse(
      controlView({
        signers: [ATTACKER],
        instructions: [opaqueIx('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')],
        postOwner: ATTACKER,
      }),
    );

    expect(report.ownerChanges).toHaveLength(1);
    expect(report.ownerChanges[0]).toMatchObject({
      account: AGENT_USDC_ATA,
      fromOwner: AGENT,
      toOwner: ATTACKER,
      amountRaw: 50_000e6,
    });
    expect(hasForeignTakeover(report, [AGENT, HOLDER])).toBe(true);
  });

  it('records a freeze, which moves neither value nor ownership', () => {
    const report = analyse(
      controlView({
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

    expect(report.takeovers).toHaveLength(1);
    expect(report.takeovers[0]).toMatchObject({
      kind: 'freeze',
      account: AGENT_USDC_ATA,
      newAuthority: ATTACKER,
      newAuthorityIsSelf: false,
      amountRaw: 50_000e6,
    });
    // The point of the case: the position delta here is zero, so nothing in
    // the exploit path would ever see this.
    expect(report.ownerChanges).toHaveLength(0);
    expect(hasForeignTakeover(report, [AGENT, HOLDER])).toBe(true);
  });

  it('records the agent handing its program to someone else', () => {
    const report = analyse(
      controlView({
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

    expect(report.takeovers).toHaveLength(1);
    expect(report.takeovers[0]).toMatchObject({
      kind: 'upgrade',
      account: AGENT_PROGRAM_DATA,
      previousAuthority: AGENT,
      newAuthority: ATTACKER,
    });
  });

  it('cannot attribute a program it has no reason to think is the agent’s', () => {
    const report = analyse(
      controlView({
        signers: [ATTACKER],
        instructions: [
          loaderIx('setAuthority', {
            account: AGENT_PROGRAM_DATA,
            authority: ATTACKER,
            newAuthority: HOLDER_SECOND_WALLET,
          }),
        ],
      }),
    );

    expect(report.takeovers).toHaveLength(0);
    expect(report.unevaluated.map((u) => u.check)).toContain('program_upgrade_authority');
  });

  it('records a delegate installation with the amount approved', () => {
    const report = analyse(
      controlView({
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

    expect(report.takeovers[0]).toMatchObject({
      kind: 'delegate',
      newAuthority: ATTACKER,
      amountRaw: 50_000e6,
      signerIsAgent: true,
    });
  });
});

describe('authority forensics — what is not a takeover', () => {
  it('treats a rotation to the holder as staying in the family', () => {
    const report = analyse(
      controlView({
        signers: [AGENT],
        instructions: [
          tokenIx('setAuthority', {
            account: AGENT_USDC_ATA,
            authorityType: 'accountOwner',
            authority: AGENT,
            newAuthority: HOLDER,
          }),
        ],
      }),
    );

    expect(report.takeovers[0]?.newAuthorityIsSelf).toBe(true);
    expect(report.foreignTakeovers).toHaveLength(0);
  });

  it('ignores control changes to accounts the agent never owned', () => {
    const report = analyse(
      rawView({
        keys: [ATTACKER, OTHER_ATA],
        signers: [ATTACKER],
        pre: [{ account: OTHER_ATA, mint: USDC, owner: ATTACKER, amount: 1e6, decimals: 6 }],
        post: [{ account: OTHER_ATA, mint: USDC, owner: HOLDER, amount: 1e6, decimals: 6 }],
        instructions: [
          tokenIx('setAuthority', {
            account: OTHER_ATA,
            authorityType: 'accountOwner',
            authority: ATTACKER,
            newAuthority: HOLDER,
          }),
        ],
      }),
    );

    expect(report.takeovers).toHaveLength(0);
    expect(report.ownerChanges).toHaveLength(0);
  });
});

describe('authority forensics — unevaluated is never absent', () => {
  it('reports an opaque multisig program rather than passing it as clean', () => {
    const report = analyse(
      controlView({ signers: [AGENT], instructions: [opaqueIx(SQUADS_V4)] }),
    );

    expect(report.takeovers).toHaveLength(0);
    expect(report.unevaluated.map((u) => u.check)).toContain('multisig_config');
    expect(report.unevaluated[0]?.reason).toContain('Squads v4');
  });

  it('reports an undecoded token instruction rather than skipping it silently', () => {
    const report = analyse(
      controlView({
        signers: [AGENT],
        instructions: [
          { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', type: null, info: null, accounts: [], inner: false, outerIndex: 0 },
        ],
      }),
    );

    expect(report.unevaluated.map((u) => u.check)).toContain('token_instruction_decode');
  });
});
