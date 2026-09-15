/**
 * Single source of truth for the /security page.
 *
 * Everything here is copied from two repository documents — never from the auditor's raw export:
 *   - docs/audit/VERIFICATION-2026-09-15-31a5d49.md — each fix verified against the tagged commit.
 *     Finding rows, the open item, the operational notes and the test run come from here.
 *   - docs/audit/REMEDIATION-2026-09-08-11b28f6.md — finding → change → test.
 *
 * Rules for editing:
 *   - After a V12 re-scan, edit this file and nothing else. Counts are derived from `FINDINGS`,
 *     so a summary number can never disagree with the rows beneath it.
 *   - Copy wording and figures from the verification document. Do NOT round, restate or improve.
 *   - A finding is `closed` only when the verification document says so. Finding 16 stays
 *     `acknowledged` until the code changes — never "fixed" or "resolved".
 *
 * Text wrapped in backticks renders as inline code.
 */

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
export type Severity = (typeof SEVERITIES)[number];

interface FindingBase {
  /** Position in the V12 report, 1–26. */
  number: number;
  /** The auditor's own identifier. */
  v12Id: string;
  severity: Severity;
  /** `true` when the report carries a machine-validated proof of concept for the finding. */
  validated: boolean;
  title: string;
}

export type AuditFinding =
  | (FindingBase & {
      status: 'closed';
      /** The change that closed it, as the verification document names it. */
      closedBy: string;
    })
  | (FindingBase & { status: 'acknowledged'; closedBy: null });

const REPO_URL = 'https://github.com/mihailShumilov/covantic';

export const AUDIT_META = {
  auditor: { name: 'V12', url: 'https://v12.sh/' },
  repo: { name: 'mihailShumilov/covantic', url: REPO_URL },
  auditedCommit: '11b28f6',
  auditedCommitFull: '11b28f66ff8de5bf645d1b1231f2357952ad82f9',
  verifiedCommit: '31a5d49',
  verifiedCommitFull: '31a5d492ac3548621f69c8f7323c4c5affb42e92',
  tag: 'audit-2026-09-15',
  verifiedOn: '2026-09-15',
  programPath: 'packages/anchor/programs/covantic',
  regressionSuite: 'packages/anchor/tests/v12-regressions.test.ts',
  documents: [
    {
      label: 'Verification — each fix checked against the tagged commit, and the test run',
      path: 'docs/audit/VERIFICATION-2026-09-15-31a5d49.md',
    },
    {
      label: 'Remediation record — finding, change, test',
      path: 'docs/audit/REMEDIATION-2026-09-08-11b28f6.md',
    },
  ],
} as const;

export const AUDIT_LINKS = {
  auditedCommit: `${REPO_URL}/commit/${AUDIT_META.auditedCommitFull}`,
  verifiedCommit: `${REPO_URL}/commit/${AUDIT_META.verifiedCommitFull}`,
  tag: `${REPO_URL}/tree/${AUDIT_META.tag}`,
  program: `${REPO_URL}/tree/${AUDIT_META.tag}/${AUDIT_META.programPath}`,
  regressionSuite: `${REPO_URL}/blob/${AUDIT_META.tag}/${AUDIT_META.regressionSuite}`,
  document: (path: string) => `${REPO_URL}/blob/main/${path}`,
} as const;

/** In the order of the verification document's tables (sections 2 and 3). */
export const FINDINGS: readonly AuditFinding[] = [
  // Section 2 — findings with a validated proof of concept
  {
    number: 15,
    v12Id: '#270299',
    severity: 'Critical',
    validated: true,
    title: 'Legacy settlement permits unproven oracle-authorized payouts',
    status: 'closed',
    closedBy:
      '`verify_and_payout` removed from `lib.rs`; `instructions/verify_and_payout.rs` deleted; a claim with no proof plans `unprovable`',
  },
  {
    number: 1,
    v12Id: '#270230',
    severity: 'High',
    validated: true,
    title: 'Partial Pyth updates fund claims',
    status: 'closed',
    closedBy: '`verify_and_payout_v2.rs` requires `VerificationLevel::Full`',
  },
  {
    number: 2,
    v12Id: '#270231',
    severity: 'High',
    validated: true,
    title: 'Settlement evidence is not policy-bound',
    status: 'closed',
    closedBy:
      '`PolicyPriceTerms` written at purchase by `create_policy`; v2 requires `evidence.feed_id == terms.feed_id` and `evidence.subject_decimals == terms.subject_decimals`',
  },
  {
    number: 3,
    v12Id: '#270239',
    severity: 'High',
    validated: true,
    title: 'Governance loss window is unenforced',
    status: 'closed',
    closedBy: '`GOVERNANCE_DRAIN_WINDOW` enforced in `verify_and_payout_governance.rs`',
  },
  {
    number: 13,
    v12Id: '#270296',
    severity: 'High',
    validated: true,
    title: 'Declared upgrade and controller coverage cannot be settled',
    status: 'closed',
    closedBy:
      '`declare_governance_baseline.rs` refuses `program_upgrade_authority`, `controller` and a non-zero threshold',
  },
  {
    number: 19,
    v12Id: '#270303',
    severity: 'High',
    validated: true,
    title: 'Repeated checkpoints erase freeze-transition evidence',
    status: 'closed',
    closedBy: '`checkpoint_authority.rs` advances `prev_*` only when the control tuple changes',
  },
  {
    number: 20,
    v12Id: '#270304',
    severity: 'High',
    validated: true,
    title: 'Governance payouts do not require a proven authority transition',
    status: 'closed',
    closedBy:
      'Purchase writes a `PolicyAuthorityCheckpoint` with a verified owner and no predecessor; settlement classifies live state against the latest permitted reading',
  },
  {
    number: 23,
    v12Id: '#270308',
    severity: 'High',
    validated: true,
    title: 'Baselines need not predate the claimed takeover',
    status: 'closed',
    closedBy:
      '`effective_at` maturity checked against the pre-incident reading in `verify_and_payout_governance.rs`',
  },
  {
    number: 26,
    v12Id: '#270311',
    severity: 'High',
    validated: true,
    title: 'Refresh erases the baseline usable at claim time',
    status: 'closed',
    closedBy:
      'Whole predecessor retained; `view_at` in `state/governance_baseline.rs` selects the declaration in force at claim time',
  },
  {
    number: 6,
    v12Id: '#270256',
    severity: 'Medium',
    validated: true,
    title: 'Malformed trigger signatures strand claims',
    status: 'closed',
    closedBy:
      'Base58 decode + 64-byte length check in `state/insurance_policy.rs`, applied by both claim entrypoints',
  },
  {
    number: 8,
    v12Id: '#270258',
    severity: 'Medium',
    validated: true,
    title: 'Policy schema version is not enforced',
    status: 'closed',
    closedBy:
      '`InsurancePolicy::assert_readable` called by 12 instructions — every policy consumer',
  },
  {
    number: 18,
    v12Id: '#270302',
    severity: 'Medium',
    validated: true,
    title: 'Unresolved pending claims permanently reserve coverage',
    status: 'closed',
    closedBy:
      '`expire_policy.rs` closes a `ClaimPending` policy past expiry, lock and `CLAIM_RESOLUTION_GRACE`',
  },
  {
    number: 4,
    v12Id: '#270249',
    severity: 'Low',
    validated: true,
    title: 'Paid claims lose proof qualification',
    status: 'closed',
    closedBy:
      '`claims.proof_kind` written by `claim-keeper.ts`, reconciled from the evidence PDA by `policy-indexer.ts`',
  },

  // Section 3 — findings marked `Invalid` by V12's validator
  {
    number: 10,
    v12Id: '#270293',
    severity: 'Low',
    validated: false,
    title: 'Unbound oracle quantity can inflate loss-based payouts',
    status: 'closed',
    closedBy:
      'v2 requires `evidence.subject_quantity <= terms.max_subject_quantity`, error `SubjectQuantityExceedsPolicy`',
  },
  {
    number: 9,
    v12Id: '#270292',
    severity: 'Low',
    validated: false,
    title: 'Unverified evidence digest recorded as settlement commitment',
    status: 'closed',
    closedBy: 'All four proof paths refuse an all-zero `bundle_hash`',
  },
  {
    number: 7,
    v12Id: '#270257',
    severity: 'Low',
    validated: false,
    title: 'Invalid policy codes permanently block lifecycle',
    status: 'closed',
    closedBy: 'Covered by `assert_readable` (version, state, trigger ranges)',
  },
  {
    number: 14,
    v12Id: '#270297',
    severity: 'Low',
    validated: false,
    title: 'Unsupported roles not rejected before wildcard',
    status: 'closed',
    closedBy:
      '`permits_role` in `state/governance_baseline.rs` returns `false` for an unknown role before the wildcard',
  },
  {
    number: 24,
    v12Id: '#270309',
    severity: 'Low',
    validated: false,
    title: 'Optional named roles permit the default pubkey',
    status: 'closed',
    closedBy: '`Some(Pubkey::default())` refused in `declare_governance_baseline.rs`',
  },
  {
    number: 5,
    v12Id: '#270250',
    severity: 'Low',
    validated: false,
    title: 'Agent-error proof kind is unstable',
    status: 'closed',
    closedBy:
      '`BREACH_*` moved to `constants.rs`; `AgentErrorBreachKind` exported from `@covantic/shared`',
  },
  {
    number: 22,
    v12Id: '#270307',
    severity: 'Low',
    validated: false,
    title: 'SDK policy tiers exceed the on-chain range',
    status: 'closed',
    closedBy: '`InsurableTier` + `isInsurableTierValue` in `packages/shared/src`',
  },
  {
    number: 25,
    v12Id: '#270310',
    severity: 'Low',
    validated: false,
    title: 'Manifest commitment excludes declared authority fields',
    status: 'closed',
    closedBy:
      '`governanceManifestCommitment` covers every field plus an extension digest; test at `packages/api/tests/governance-manifest-commitment.test.ts`',
  },
  {
    number: 21,
    v12Id: '#270306',
    severity: 'Low',
    validated: false,
    title: 'Proof-status audit signal relies on unauthenticated logs',
    status: 'closed',
    closedBy: 'Same change as finding 4 — status written at payout, reconciled from the PDA',
  },
  {
    number: 11,
    v12Id: '#270294',
    severity: 'Low',
    validated: false,
    title: 'Demo timing feature can be deployed with production claims',
    status: 'closed',
    closedBy:
      '`devnet-fast-lock` is a `#[cfg(feature)]` gate; `scripts/deploy-devnet.sh` passes it only with `--fast-lock` and refuses on mainnet; checklist in `docs/DEPLOYMENT.md`',
  },
  {
    number: 12,
    v12Id: '#270295',
    severity: 'Low',
    validated: false,
    title: 'Exploit-lock documentation conflicts with executable policy',
    status: 'closed',
    closedBy:
      '`LOCK_EXPLOIT = 3600` (production), shared TS `EXPLOIT: 3600`, README coverage table states 1 hour — all three agree',
  },
  {
    number: 17,
    v12Id: '#270301',
    severity: 'Low',
    validated: false,
    title: 'Public PDA documentation conflicts with canonical seeds',
    status: 'closed',
    closedBy: 'State-account comments name the `*_SEED` constants',
  },
  {
    number: 16,
    v12Id: '#270300',
    severity: 'Low',
    validated: false,
    title: 'Unauthenticated trade evidence can support fabricated payouts',
    status: 'acknowledged',
    closedBy: null,
  },
];

export interface FindingCount {
  total: number;
  closed: number;
  acknowledged: number;
}

export function countFindings(rows: readonly AuditFinding[]): FindingCount {
  return {
    total: rows.length,
    closed: rows.filter((f) => f.status === 'closed').length,
    acknowledged: rows.filter((f) => f.status === 'acknowledged').length,
  };
}

export const SEVERITY_COUNTS: readonly (FindingCount & { severity: Severity })[] = SEVERITIES.map(
  (severity) => ({
    severity,
    ...countFindings(FINDINGS.filter((f) => f.severity === severity)),
  }),
);

export const TOTAL_COUNT: FindingCount = countFindings(FINDINGS);

export const VALIDATED_FINDINGS = FINDINGS.filter((f) => f.validated);
export const UNVALIDATED_FINDINGS = FINDINGS.filter((f) => !f.validated);
export const ACKNOWLEDGED_FINDINGS = FINDINGS.filter((f) => f.status === 'acknowledged');

export const FINDING_CLASSES = {
  validated: {
    title: 'Findings with a validated proof of concept',
    description:
      'Each carries a machine-validated proof of concept in the report, with validation reasoning, a patch and the validation output.',
  },
  unvalidated: {
    title: 'Observations marked `Invalid` by the auditor’s validator',
    description:
      '`Invalid` is the verdict of V12’s own validator: these findings carry a description, a root cause and an impact, but no reproduction and no patch.',
  },
} as const;

export const SCOPE = {
  summary:
    'V12 audited the repository `mihailShumilov/covantic` at `11b28f6`. Its core is the Solana program in `packages/anchor/programs/covantic`, which holds the three contracts below.',
  contracts: [
    {
      name: 'Policy purchase',
      detail:
        'A holder buys cover for an agent. The price comes from an oracle-signed risk attestation, and the purchase writes the records a later claim is judged against.',
      instructions: ['create_policy', 'upsert_attestation', 'cancel_policy'],
    },
    {
      name: 'Staker-funded vault',
      detail:
        'Stakers deposit USDC into the vault that backs every policy and earn from the premiums it collects. Withdrawal is two-step, behind a cooldown.',
      instructions: ['stake', 'request_unstake', 'execute_unstake', 'claim_rewards'],
    },
    {
      name: 'Parametric payout engine',
      detail:
        'A claim settles only through the proof instruction for its trigger, which re-derives the payout bound from state the program reads itself.',
      instructions: [
        'submit_claim',
        'oracle_submit_claim',
        'verify_and_payout_v2',
        'verify_and_payout_exploit',
        'verify_and_payout_governance',
        'verify_and_payout_agent_error',
        'expire_policy',
      ],
    },
  ],
  offChain:
    'Some findings concern the off-chain code around the program instead: the claim keeper, the policy indexer and the shared TypeScript types (findings 4, 21, 22 and 25).',
} as const;

export interface OpenItem {
  findingNumber: number;
  /** What the program does not prove. */
  gap: string;
  /** What limits the exposure while the gap stays open. */
  bounds: readonly string[];
  documentedIn: string;
  /** What closing it would take. */
  resolution: string;
}

/** Section 4 of the verification document. */
export const OPEN_ITEMS: readonly OpenItem[] = [
  {
    findingNumber: 16,
    gap: '`verify_and_payout_v2` authenticates the Pyth reference price and checks timing, arithmetic and a minimum deviation, but `executed_price`, `subject_quantity` and `trigger_block_time` are accepted from the evidence account as assertions about a historical trade. The policy’s persisted `trigger_tx_signature` is not used to prove that the asserted execution occurred.',
    bounds: [
      'the feed, decimals and maximum quantity are fixed per policy at purchase (`PolicyPriceTerms`), so the oracle cannot choose the instrument or inflate the size after the fact;',
      'the reference price must be a fully verified Pyth update sitting next to the asserted trade within `MAX_PRICE_EVIDENCE_SKEW`;',
      'the payout is capped by what the signed price can support;',
      'the evidence commitment and the lock window make a fabricated claim falsifiable before it pays.',
    ],
    documentedIn: 'The limitation is documented in the docblock on `verify_and_payout_v2`.',
    resolution:
      'Closing it properly means binding settlement to the trigger transaction itself, which is a design change rather than a patch.',
  },
];

/** Section 5 of the verification document. */
export const OPERATIONAL_NOTES: readonly string[] = [
  '`pnpm gov:migrate` must be run once after the program upgrade. The authority crank grows an undersized checkpoint on its own, and the attestation publisher grows an undersized attestation.',
  'Policies bought before the upgrade have no `PolicyPriceTerms`; their oracle-manipulation claims plan `unprovable` and go to manual review.',
  'Policies bought before the upgrade have no purchase-time authority reading, so a takeover landing before the crank’s second post-upgrade tick is not provable and goes to review.',
];

/** Section 6 of the verification document. */
export const TEST_RUN = {
  date: '2026-09-15',
  commit: '31a5d49',
  toolchain: ['Agave 3.1.14', 'anchor-cli 1.0.2'],
  /** Run from the repository root. */
  prepare: ['pnpm --filter @covantic/shared build'],
  directory: 'packages/anchor',
  /** Run from `directory`, in order. */
  commands: [
    'anchor build --ignore-keys',
    'cargo test -p covantic --lib',
    'anchor test --skip-build --skip-local-validator --skip-deploy --provider.cluster localnet',
  ],
  results: [
    { suite: 'Anchor suite, all 4 test files', passed: 103, failed: 0 },
    { suite: '— of which v12-regressions.test.ts', passed: 22, failed: 0 },
    { suite: 'Program unit tests (cargo test)', passed: 38, failed: 0 },
  ],
} as const;

export const INTERNAL_REVIEWS_NOTE =
  '`docs/audit/` also holds two earlier reports, `AUDIT-2026-08-25-bf01e5e8.md` and `AUDIT-2026-08-31-2a0c9a70.md`. Both are internal reviews written in-house, not independent audits, and nothing on this page relies on them.';
