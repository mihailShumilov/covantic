import { canonicalMint } from '@covantic/shared';
import { feePayer, isSigner, type ParsedIx, type RawTxView } from '../exploit/raw-tx.js';
import { TOKEN_PROGRAM_IDS } from '../exploit/authorization.js';

/**
 * Who controls the agent's accounts, before and after.
 *
 * The exploit path's {@link ../exploit/authorization.ts} asks who authorised
 * *money moving*. This asks a different question — who is permitted to move
 * it at all — and the difference is not academic. Three shapes are completely
 * invisible to a transfer-shaped view:
 *
 *   1. **Freeze.** `FreezeAccount` by a foreign freeze authority. The balance
 *      does not change and the owner does not change; the agent simply can no
 *      longer move its own funds. The exploit adjudicator sees a zero
 *      position delta and rejects it as `no_net_loss`.
 *   2. **Upgrade-authority seizure.** The agent's program changes hands. No
 *      token account is touched at all.
 *   3. **Delegate installation.** `Approve` grants an allowance to be pulled
 *      later, possibly days later, in a transaction that looks ordinary.
 *
 * A fourth — owner seizure via `SetAuthority(AccountOwner)` — *is* visible to
 * the exploit path, which values it correctly. It still belongs here, for a
 * reason that only shows up at settlement: see the note on
 * {@link ownerChanges} below.
 *
 * Every finding is a fact read off the transaction, not a judgement. Weighing
 * them is `signatures.ts`'s job and deciding is the adjudicator's.
 */

/** SPL Token instruction names that move control rather than value. */
const CONTROL_TYPES = new Set(['setAuthority', 'closeAccount', 'freezeAccount']);

/** Instruction names that grant a spending allowance. */
const APPROVE_TYPES = new Set(['approve', 'approveChecked']);

/** The upgradeable loader. A program's authority lives here, not in any token
 *  account, which is why nothing in the exploit path can see it change. */
export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';

/** Loader instruction names that hand a program to someone else. */
const LOADER_AUTHORITY_TYPES = new Set(['setAuthority', 'setAuthorityChecked']);

/**
 * Programs whose *config* is a governance surface but whose instructions the
 * RPC does not parse. Their presence is recorded as `unevaluated`, never as
 * absent — a Squads threshold change is exactly the kind of thing that must
 * not read as "we checked and nothing happened".
 */
export const OPAQUE_CONTROL_PROGRAMS = new Map<string, string>([
  // Squads v4 — the dominant Solana multisig. Threshold changes, spending
  // limits and member removals all live here and none of them are jsonParsed.
  ['SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf', 'Squads v4'],
  // Squads v3 (squads-mpl). Immutable since its upgrade authority was burned
  // in February 2023, and still holding funds.
  ['SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu', 'Squads v3'],
  // Already trusted elsewhere in this codebase — see GOVERNANCE_PROGRAM_IDS
  // in verifiers/common.ts, which these two are copied from rather than
  // guessed at. The house rule holds: a program earns a place here only once
  // a test case proves the detection behaves, never on recollection.
  ['GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw', 'SPL Governance'],
  ['autoQP9RmUNkzzKRXsMkWicDVZ3h29vvyMDcAYjCxxg', 'Metadao'],
]);

export type TakeoverKind =
  /** The token account's owner changed. */
  | 'owner'
  /** A close authority was installed — whoever holds it can destroy the account. */
  | 'close'
  /** The account was frozen. */
  | 'freeze'
  /** A spending allowance was granted. */
  | 'delegate'
  /** The agent's program changed hands. */
  | 'upgrade';

/** One change to who controls something the agent held. */
export interface Takeover {
  kind: TakeoverKind;
  /** Token account, or the program-data account for `upgrade`. */
  account: string;
  mint: string | null;
  /** What sat in the account when control changed, raw base units. Null when
   *  the transaction carried no balance for it. */
  amountRaw: number | null;
  previousAuthority: string | null;
  newAuthority: string | null;
  /** Who signed for the change. Null when the RPC reported an unresolved
   *  multisig. */
  signer: string | null;
  signerIsAgent: boolean;
  signerIsHolder: boolean;
  /** The new controller resolves to the agent or the holder — a rotation
   *  inside the family, not a takeover. */
  newAuthorityIsSelf: boolean;
  viaCpi: boolean;
  /** Program that invoked it; the outer instruction's program for a CPI. */
  invokedBy: string;
}

/** A token account that stopped being the agent's, seen in the balance
 *  snapshots rather than in a decoded instruction. */
export interface OwnerChange {
  account: string;
  mint: string;
  fromOwner: string;
  toOwner: string | null;
  amountRaw: number;
}

export interface AuthorityReport {
  agentWasSigner: boolean;
  holderWasSigner: boolean;
  feePayer: string | null;
  /** Transaction reverted on chain: nothing changed hands. */
  failed: boolean;

  takeovers: Takeover[];
  /** Takeovers whose new controller is neither the agent nor the holder.
   *  The set the adjudicator's hard requirement is drawn from. */
  foreignTakeovers: Takeover[];

  /**
   * Owner changes read from `pre`/`postTokenBalances`.
   *
   * Kept separately from {@link takeovers} because it catches the case where
   * no instruction was decoded — an opaque program that reassigned the
   * account through a CPI the RPC did not parse. A seizure is visible in the
   * snapshots whether or not anyone could read the instruction that caused it.
   */
  ownerChanges: OwnerChange[];

  /** Token accounts the agent owned going in. */
  agentAccounts: string[];

  /** Checks that could not run, with why. Never conflated with "absent". */
  unevaluated: Array<{ check: string; reason: string }>;
}

export interface AuthorityInput {
  view: RawTxView;
  agentAddress: string;
  holderAddress?: string;
}

/**
 * Read the control facts off a transaction.
 *
 * Pure: everything it needs is in the {@link RawTxView}. A caller holding
 * only the indexer payload cannot call this, which is deliberate — the
 * payload has no signer flags and no per-side token account owners, so every
 * answer would be a guess.
 */
export function analyseAuthority(input: AuthorityInput): AuthorityReport {
  const { view, agentAddress, holderAddress } = input;
  const unevaluated: Array<{ check: string; reason: string }> = [];

  const agentAccounts = new Set(
    view.preTokenBalances.filter((s) => s.owner === agentAddress).map((s) => s.account),
  );
  // An account created inside this transaction and immediately assigned
  // elsewhere never appears in the pre-side. Including the post-side owned
  // accounts keeps a same-transaction create-and-seize visible.
  for (const s of view.postTokenBalances) {
    if (s.owner === agentAddress) agentAccounts.add(s.account);
  }

  const selfAddresses = new Set<string>([agentAddress]);
  if (holderAddress) selfAddresses.add(holderAddress);

  const amountByAccount = new Map<string, { amountRaw: number; mint: string }>();
  for (const s of view.preTokenBalances) {
    amountByAccount.set(s.account, { amountRaw: s.amountRaw, mint: s.mint });
  }

  const outerProgram = new Map<number, string>();
  for (const ix of view.instructions) {
    if (!ix.inner) outerProgram.set(ix.outerIndex, ix.programId);
  }

  const takeovers: Takeover[] = [];

  for (const ix of view.instructions) {
    const invokedBy = ix.inner ? (outerProgram.get(ix.outerIndex) ?? ix.programId) : ix.programId;

    if (OPAQUE_CONTROL_PROGRAMS.has(ix.programId)) {
      unevaluated.push({
        check: 'multisig_config',
        reason:
          `${OPAQUE_CONTROL_PROGRAMS.get(ix.programId)} was invoked at outer index ` +
          `${ix.outerIndex}; the RPC does not decode its instructions, so a config or ` +
          'threshold change cannot be ruled in or out.',
      });
      continue;
    }

    if (ix.programId === BPF_LOADER_UPGRADEABLE) {
      const takeover = loaderTakeover(ix, agentAddress, selfAddresses, unevaluated, invokedBy);
      if (takeover) takeovers.push(takeover);
      continue;
    }

    if (!TOKEN_PROGRAM_IDS.has(ix.programId)) continue;

    if (!ix.type) {
      unevaluated.push({
        check: 'token_instruction_decode',
        reason: `Token-program instruction at outer index ${ix.outerIndex} was not decoded by the RPC.`,
      });
      continue;
    }

    const info = ix.info ?? {};

    if (CONTROL_TYPES.has(ix.type)) {
      const account = str(info.account);
      if (!account || !agentAccounts.has(account)) continue;
      const balance = amountByAccount.get(account);
      const signer = resolveSigner(info, ix, unevaluated);
      const { kind, newAuthority } = controlShape(ix.type, info);
      takeovers.push({
        kind,
        account,
        mint: balance ? canonicalMint(balance.mint) : (str(info.mint) ?? null),
        amountRaw: balance?.amountRaw ?? null,
        // The authority that signed is, by definition of these instructions,
        // the authority being exercised — and therefore the previous one.
        previousAuthority: signer,
        newAuthority,
        signer,
        signerIsAgent: signer === agentAddress,
        signerIsHolder: holderAddress !== undefined && signer === holderAddress,
        newAuthorityIsSelf: newAuthority !== null && selfAddresses.has(newAuthority),
        viaCpi: ix.inner,
        invokedBy,
      });
      continue;
    }

    if (APPROVE_TYPES.has(ix.type)) {
      const source = str(info.source);
      const delegate = str(info.delegate);
      if (!source || !delegate || !agentAccounts.has(source)) continue;
      const balance = amountByAccount.get(source);
      const signer = str(info.owner) ?? resolveSigner(info, ix, unevaluated);
      takeovers.push({
        kind: 'delegate',
        account: source,
        mint: balance ? canonicalMint(balance.mint) : (str(info.mint) ?? null),
        amountRaw: approvedAmount(info) ?? balance?.amountRaw ?? null,
        previousAuthority: signer,
        newAuthority: delegate,
        signer,
        signerIsAgent: signer === agentAddress,
        signerIsHolder: holderAddress !== undefined && signer === holderAddress,
        newAuthorityIsSelf: selfAddresses.has(delegate),
        viaCpi: ix.inner,
        invokedBy,
      });
    }
  }

  const ownerChanges = readOwnerChanges(view, agentAddress);

  if (view.instructions.length === 0) {
    unevaluated.push({
      check: 'instruction_analysis',
      reason: 'Transaction view carried no instructions; control changes cannot be attributed.',
    });
  }

  return {
    agentWasSigner: isSigner(view, agentAddress),
    holderWasSigner: holderAddress !== undefined && isSigner(view, holderAddress),
    feePayer: feePayer(view),
    failed: view.err !== null && view.err !== undefined,
    takeovers,
    foreignTakeovers: takeovers.filter((t) => !t.newAuthorityIsSelf),
    ownerChanges,
    agentAccounts: [...agentAccounts].sort(),
    unevaluated,
  };
}

/**
 * Did control of anything the agent held leave the agent and the holder?
 *
 * The one-line summary the screen and the adjudicator lean on. An owner
 * change seen in the snapshots counts even with no decoded instruction behind
 * it: the account stopped being the agent's, and how that was arranged does
 * not change the fact.
 */
export function hasForeignTakeover(report: AuthorityReport, selfAddresses: string[]): boolean {
  if (report.foreignTakeovers.length > 0) return true;
  const self = new Set(selfAddresses);
  return report.ownerChanges.some((c) => c.toOwner === null || !self.has(c.toOwner));
}

// ---------------------------------------------------------------------------

/**
 * Map a decoded control instruction onto the kind of control it moved.
 *
 * `setAuthority` is three different events depending on `authorityType`, and
 * collapsing them would lose the distinction between "someone else owns this
 * now" and "someone else can freeze it".
 */
function controlShape(
  type: string,
  info: Record<string, unknown>,
): { kind: TakeoverKind; newAuthority: string | null } {
  if (type === 'closeAccount') {
    // Closing sends the rent somewhere and destroys the account. The
    // destination is the closest thing to a new controller there is.
    return { kind: 'close', newAuthority: str(info.destination) };
  }
  if (type === 'freezeAccount') {
    return { kind: 'freeze', newAuthority: str(info.freezeAuthority) ?? str(info.authority) };
  }

  const authorityType = str(info.authorityType);
  const newAuthority = str(info.newAuthority);
  switch (authorityType) {
    case 'closeAccount':
      return { kind: 'close', newAuthority };
    case 'freezeAccount':
      return { kind: 'freeze', newAuthority };
    default:
      // `accountOwner`, and anything the RPC spells differently. Treating an
      // unrecognised authority type as an owner change is the conservative
      // direction: it raises rather than hides.
      return { kind: 'owner', newAuthority };
  }
}

/**
 * A program changing hands.
 *
 * Attribution is the hard part: without the holder's declared baseline
 * nothing links an arbitrary program to this agent. One case is unambiguous
 * on its own, though — the authority being *given up* is the agent itself, in
 * which case the program was the agent's by construction. Anything else is
 * recorded as unevaluated rather than guessed at.
 */
function loaderTakeover(
  ix: ParsedIx,
  agentAddress: string,
  selfAddresses: Set<string>,
  unevaluated: Array<{ check: string; reason: string }>,
  invokedBy: string,
): Takeover | null {
  if (!ix.type) {
    unevaluated.push({
      check: 'loader_instruction_decode',
      reason: `Upgradeable-loader instruction at outer index ${ix.outerIndex} was not decoded.`,
    });
    return null;
  }
  if (!LOADER_AUTHORITY_TYPES.has(ix.type)) return null;

  const info = ix.info ?? {};
  const current = str(info.authority);
  const account = str(info.account) ?? ix.accounts[0] ?? null;
  if (!account) return null;

  if (current !== agentAddress) {
    unevaluated.push({
      check: 'program_upgrade_authority',
      reason:
        `Upgrade authority of ${account} moved from ${current ?? 'an unreported key'}, which ` +
        'is not the covered agent. Without a declared program for this policy the change ' +
        'cannot be attributed to it.',
    });
    return null;
  }

  const newAuthority = str(info.newAuthority);
  return {
    kind: 'upgrade',
    account,
    mint: null,
    amountRaw: null,
    previousAuthority: current,
    newAuthority,
    signer: current,
    signerIsAgent: true,
    signerIsHolder: false,
    newAuthorityIsSelf: newAuthority !== null && selfAddresses.has(newAuthority),
    viaCpi: ix.inner,
    invokedBy,
  };
}

/** Token accounts the agent owned going in and did not own coming out. */
function readOwnerChanges(view: RawTxView, agentAddress: string): OwnerChange[] {
  const post = new Map(view.postTokenBalances.map((s) => [s.account, s]));
  const changes: OwnerChange[] = [];
  for (const pre of view.preTokenBalances) {
    if (pre.owner !== agentAddress) continue;
    const after = post.get(pre.account);
    // Absent from the post side means the account was closed, which the
    // instruction scan reports as a `close` takeover. Only a *changed* owner
    // belongs here.
    if (!after || after.owner === agentAddress) continue;
    changes.push({
      account: pre.account,
      mint: canonicalMint(pre.mint),
      fromOwner: agentAddress,
      toOwner: after.owner,
      amountRaw: after.amountRaw || pre.amountRaw,
    });
  }
  return changes;
}

function resolveSigner(
  info: Record<string, unknown>,
  ix: ParsedIx,
  unevaluated: Array<{ check: string; reason: string }>,
): string | null {
  const direct = str(info.authority) ?? str(info.owner) ?? str(info.freezeAuthority);
  if (direct) return direct;

  const multisig = str(info.multisigAuthority) ?? str(info.multisigOwner);
  const signers = Array.isArray(info.signers) ? info.signers.map((s) => String(s)) : [];
  if (multisig) {
    if (signers.length === 1) return signers[0]!;
    unevaluated.push({
      check: 'multisig_authority',
      reason: `Multisig ${multisig} signed with ${signers.length} signers; no single authority to attribute.`,
    });
    return null;
  }

  unevaluated.push({
    check: 'control_authority',
    reason: `No authority field on decoded ${ix.type} instruction.`,
  });
  return null;
}

function approvedAmount(info: Record<string, unknown>): number | null {
  const direct = info.amount;
  if (typeof direct === 'string' || typeof direct === 'number') {
    const n = Number(direct);
    return Number.isFinite(n) ? n : null;
  }
  const checked = info.tokenAmount as { amount?: unknown } | undefined;
  if (checked && (typeof checked.amount === 'string' || typeof checked.amount === 'number')) {
    const n = Number(checked.amount);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
