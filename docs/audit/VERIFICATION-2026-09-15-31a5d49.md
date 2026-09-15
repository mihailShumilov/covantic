# Verification of the V12 audit against `31a5d49`

|                        |                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Protocol**           | Covantic — parametric insurance for AI agents on Solana                                                                                                                             |
| **Source report**      | [V12](https://v12.sh/), scope `mihailShumilov/covantic@11b28f6`, 26 findings                                                                                                        |
| **Remediation record** | `docs/audit/REMEDIATION-2026-09-08-11b28f6.md`                                                                                                                                      |
| **Verified against**   | `main` @ `31a5d492ac3548621f69c8f7323c4c5affb42e92`                                                                                                                                 |
| **Date**               | 2026-09-15                                                                                                                                                                          |
| **Method**             | Static verification — each finding's claimed fix located in the current source — followed by a run of the Anchor suite and the program's unit tests on the same commit (section 6). |

---

## 1. Summary

|           | Count  | Closed in code | Acknowledged, not fixed |
| --------- | ------ | -------------- | ----------------------- |
| Critical  | 1      | 1              | 0                       |
| High      | 8      | 8              | 0                       |
| Medium    | 3      | 3              | 0                       |
| Low       | 14     | 13             | 1                       |
| **Total** | **26** | **25**         | **1**                   |

The report separates its own findings into two classes, and the distinction matters when reading
the table above:

- **13 findings carry a machine-validated proof of concept** (sections _Proof of concept_,
  _Validation reasoning_, _Patch_, _Validation output_). These are the 1 Critical, 8 High,
  3 Medium and 1 Low. Every one of them is closed.
- **13 findings are marked `Validity: Invalid` by V12's own validator** and carry only
  _Description_, _Root cause_ and _Impact_ — no reproduction, no patch. All 13 are Low, and they
  read as code-quality, documentation and ABI-hygiene observations rather than exploitable
  defects. 12 were closed anyway; 1 (finding 16) is accepted as a known limitation.

One finding is deliberately **not** fixed. It is described in section 4 and must be carried into
any published report as _Acknowledged_, not _Fixed_.

---

## 2. Findings with a validated proof of concept

| #   | V12 id  | Severity | Finding                                                         | Status     | Where it is closed                                                                                                                                                   |
| --- | ------- | -------- | --------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15  | #270299 | Critical | Legacy settlement permits unproven oracle-authorized payouts    | **Closed** | `verify_and_payout` removed from `lib.rs`; `instructions/verify_and_payout.rs` deleted; a claim with no proof plans `unprovable`                                     |
| 1   | #270230 | High     | Partial Pyth updates fund claims                                | **Closed** | `verify_and_payout_v2.rs` requires `VerificationLevel::Full`                                                                                                         |
| 2   | #270231 | High     | Settlement evidence is not policy-bound                         | **Closed** | `PolicyPriceTerms` written at purchase by `create_policy`; v2 requires `evidence.feed_id == terms.feed_id` and `evidence.subject_decimals == terms.subject_decimals` |
| 3   | #270239 | High     | Governance loss window is unenforced                            | **Closed** | `GOVERNANCE_DRAIN_WINDOW` enforced in `verify_and_payout_governance.rs`                                                                                              |
| 13  | #270296 | High     | Declared upgrade and controller coverage cannot be settled      | **Closed** | `declare_governance_baseline.rs` refuses `program_upgrade_authority`, `controller` and a non-zero threshold                                                          |
| 19  | #270303 | High     | Repeated checkpoints erase freeze-transition evidence           | **Closed** | `checkpoint_authority.rs` advances `prev_*` only when the control tuple changes                                                                                      |
| 20  | #270304 | High     | Governance payouts do not require a proven authority transition | **Closed** | Purchase writes a `PolicyAuthorityCheckpoint` with a verified owner and no predecessor; settlement classifies live state against the latest permitted reading        |
| 23  | #270308 | High     | Baselines need not predate the claimed takeover                 | **Closed** | `effective_at` maturity checked against the pre-incident reading in `verify_and_payout_governance.rs`                                                                |
| 26  | #270311 | High     | Refresh erases the baseline usable at claim time                | **Closed** | Whole predecessor retained; `view_at` in `state/governance_baseline.rs` selects the declaration in force at claim time                                               |
| 6   | #270256 | Medium   | Malformed trigger signatures strand claims                      | **Closed** | Base58 decode + 64-byte length check in `state/insurance_policy.rs`, applied by both claim entrypoints                                                               |
| 8   | #270258 | Medium   | Policy schema version is not enforced                           | **Closed** | `InsurancePolicy::assert_readable` called by 12 instructions — every policy consumer                                                                                 |
| 18  | #270302 | Medium   | Unresolved pending claims permanently reserve coverage          | **Closed** | `expire_policy.rs` closes a `ClaimPending` policy past expiry, lock and `CLAIM_RESOLUTION_GRACE`                                                                     |
| 4   | #270249 | Low      | Paid claims lose proof qualification                            | **Closed** | `claims.proof_kind` written by `claim-keeper.ts`, reconciled from the evidence PDA by `policy-indexer.ts`                                                            |

## 3. Findings marked `Invalid` by V12's validator

| #   | V12 id  | Finding                                                       | Status                       | Where it is closed                                                                                                                                                     |
| --- | ------- | ------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | #270293 | Unbound oracle quantity can inflate loss-based payouts        | **Closed**                   | v2 requires `evidence.subject_quantity <= terms.max_subject_quantity`, error `SubjectQuantityExceedsPolicy`                                                            |
| 9   | #270292 | Unverified evidence digest recorded as settlement commitment  | **Closed**                   | All four proof paths refuse an all-zero `bundle_hash`                                                                                                                  |
| 7   | #270257 | Invalid policy codes permanently block lifecycle              | **Closed**                   | Covered by `assert_readable` (version, state, trigger ranges)                                                                                                          |
| 14  | #270297 | Unsupported roles not rejected before wildcard                | **Closed**                   | `permits_role` in `state/governance_baseline.rs` returns `false` for an unknown role before the wildcard                                                               |
| 24  | #270309 | Optional named roles permit the default pubkey                | **Closed**                   | `Some(Pubkey::default())` refused in `declare_governance_baseline.rs`                                                                                                  |
| 5   | #270250 | Agent-error proof kind is unstable                            | **Closed**                   | `BREACH_*` moved to `constants.rs`; `AgentErrorBreachKind` exported from `@covantic/shared`                                                                            |
| 22  | #270307 | SDK policy tiers exceed the on-chain range                    | **Closed**                   | `InsurableTier` + `isInsurableTierValue` in `packages/shared/src`                                                                                                      |
| 25  | #270310 | Manifest commitment excludes declared authority fields        | **Closed**                   | `governanceManifestCommitment` covers every field plus an extension digest; test at `packages/api/tests/governance-manifest-commitment.test.ts`                        |
| 21  | #270306 | Proof-status audit signal relies on unauthenticated logs      | **Closed**                   | Same change as finding 4 — status written at payout, reconciled from the PDA                                                                                           |
| 11  | #270294 | Demo timing feature can be deployed with production claims    | **Closed**                   | `devnet-fast-lock` is a `#[cfg(feature)]` gate; `scripts/deploy-devnet.sh` passes it only with `--fast-lock` and refuses on mainnet; checklist in `docs/DEPLOYMENT.md` |
| 12  | #270295 | Exploit-lock documentation conflicts with executable policy   | **Closed**                   | `LOCK_EXPLOIT = 3600` (production), shared TS `EXPLOIT: 3600`, README coverage table states 1 hour — all three agree                                                   |
| 17  | #270301 | Public PDA documentation conflicts with canonical seeds       | **Closed**                   | State-account comments name the `*_SEED` constants                                                                                                                     |
| 16  | #270300 | Unauthenticated trade evidence can support fabricated payouts | **Acknowledged — not fixed** | See section 4                                                                                                                                                          |

---

## 4. The one open item — finding 16 (#270300, Low, `Invalid`)

`verify_and_payout_v2` authenticates the Pyth reference price and checks timing, arithmetic and a
minimum deviation, but `executed_price`, `subject_quantity` and `trigger_block_time` are accepted
from the evidence account as assertions about a historical trade. The policy's persisted
`trigger_tx_signature` is not used to prove that the asserted execution occurred.

**This is accepted, not closed.** What bounds it today:

- the feed, decimals and maximum quantity are fixed per policy at purchase (`PolicyPriceTerms`),
  so the oracle cannot choose the instrument or inflate the size after the fact;
- the reference price must be a fully verified Pyth update sitting next to the asserted trade
  within `MAX_PRICE_EVIDENCE_SKEW`;
- the payout is capped by what the signed price can support;
- the evidence commitment and the lock window make a fabricated claim falsifiable before it pays.

The limitation is documented in the docblock on `verify_and_payout_v2`. Closing it properly means
binding settlement to the trigger transaction itself, which is a design change rather than a patch.

---

## 5. Operational carry-overs

Not findings, but residual risk on already-deployed state that belongs in any status report:

- `pnpm gov:migrate` must be run once after the program upgrade. The authority crank grows an
  undersized checkpoint on its own, and the attestation publisher grows an undersized attestation.
- Policies bought before the upgrade have no `PolicyPriceTerms`; their oracle-manipulation claims
  plan `unprovable` and go to manual review.
- Policies bought before the upgrade have no purchase-time authority reading, so a takeover
  landing before the crank's second post-upgrade tick is not provable and goes to review.

## 6. Scope of this verification

Each fix was located in the current source of `main` @ `31a5d49`. The regression suite
`packages/anchor/tests/v12-regressions.test.ts` (995 lines) names its cases after the finding
numbers and is the executable counterpart to this document. It was run on the same commit:

|                        |                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Date**               | 2026-09-15                                                                                                             |
| **Commit**             | `31a5d492ac3548621f69c8f7323c4c5affb42e92`, tag `audit-2026-09-15`                                                     |
| **Toolchain**          | Agave 3.1.14, anchor-cli 1.0.2                                                                                         |
| **Program build**      | Rebuilt from that commit with default features — no `devnet-fast-lock`, so every lock constant is the production value |
| **Anchor suite**       | 4 files, **103 passed, 0 failed**; of these, `v12-regressions.test.ts` **22 passed, 0 failed**                         |
| **Program unit tests** | `cargo test -p covantic --lib`: **38 passed, 0 failed**                                                                |

Commands, exactly as run:

```bash
pnpm --filter @covantic/shared build   # the suite imports @covantic/shared from dist
cd packages/anchor
anchor build --ignore-keys
cargo test -p covantic --lib
anchor test --skip-build --skip-local-validator --skip-deploy --provider.cluster localnet
```

`--provider.cluster localnet` is explicit because `Anchor.toml` sets the provider to devnet: a
bare `anchor test`, which is what `pnpm test:anchor` runs, would try to deploy there. The suite
runs in process on `solana-bankrun`, so skipping the local validator and the deploy removes
nothing it uses.

A green suite shows the fixes hold against the cases written for them. It does not replace an
independent check: a clean re-scan by V12 is what turns the statements above into third-party
evidence.
