---
name: finding-classification
description: How to price, categorise, identify and write up a single security finding to third-party-audit-firm standard — the Likelihood × Impact severity matrix, the category taxonomy, finding IDs, the required finding block, the status lifecycle, and the evidence bar that stops severity inflation. Load whenever writing or reviewing a security finding, assigning a severity, deduping findings from several reviewers, or arbitrating a disagreement about how bad something is.
---

# Classifying a Finding

Severity is a claim about the world, and a wrong one is expensive in both
directions. Inflated severity trains the reader to discount the report;
deflated severity is how the money leaves.

## Severity — Likelihood × Impact

Assign both axes independently, then read the cell. Never assign severity
directly.

**Impact** — what the attacker gets if it works:

| | |
|---|---|
| **Critical** | Vault drained, arbitrary payout, upgrade authority stolen, oracle authority compromised |
| **High** | Bounded but material theft; any holder can extract more than they paid; permanent freeze of user funds |
| **Medium** | Griefing at cost; a claim resolves wrongly in one direction; temporary DoS of the claim pipeline |
| **Low** | Information disclosure, recoverable misbehaviour, degraded accounting that self-heals |

**Likelihood** — what it costs to get there:

| | |
|---|---|
| **High** | Anonymous caller, one transaction, no special position or timing |
| **Medium** | Needs to be a policyholder or staker, or needs a specific but reachable state |
| **Low** | Needs operator compromise, validator-level control, or a race with a narrow window |

|              | Impact: Critical | High | Medium | Low |
|---|---|---|---|---|
| **Likelihood: High** | Critical | Critical | Major | Minor |
| **Medium** | Critical | Major | Medium | Minor |
| **Low** | Major | Medium | Minor | Informational |

**Informational** is also the home for correct-but-fragile code, style, and
documentation drift. It is a real category, not a consolation prize — but never
downgrade something with an exploit path into it.

### Calibration for this protocol

These are settled. Do not relitigate them per-finding.

- Missing signer or authority check on any path that moves vault USDC → **Critical**, regardless of how unlikely it looks.
- A `TokenAccount` in a transfer path with no `constraint = x.mint == config.usdc_mint` → **Critical** (accepts a worthless mint).
- Unchecked arithmetic on a payout, premium, or vault total → **Major** minimum; **Critical** if it can inflate a payout.
- `init_if_needed` on an account holding a running total or previous value → **Major** (reinitialisation resets a baseline the payout is measured against).
- Off-chain analysis able to release funds without the chain's own check — i.e. the `CONFIDENCE_CEILING` < `AUTO_PAY_CONFIDENCE` gap closing → **Critical**.
- A trigger a policyholder can cause profitably → **Major** minimum, priced in USDC; **Critical** if the profit is unbounded.
- Oracle authority able to pay an amount the chain never verifies → **Major**, and always also a Centralization finding.
- A verdict path that turns an unavailable data source into `rejected` instead of `indeterminate` → **Medium** (it silently denies coverage) — see `CLAUDE.md`.
- Secrets in the repo or in an image layer → **Major**; **Critical** if the key signs on-chain or is the alert HMAC.

## Category

Every finding carries exactly one.

| Category | What belongs |
|---|---|
| `Centralization / Privilege` | A role can do something users cannot check or stop |
| `Logical Issue` | The code does something other than what it must |
| `Volatile Code` | Correct today, silently breaks on a plausible input or state |
| `Data Flow` | Untrusted value reaches a trusted decision |
| `Design Issue` | The mechanism cannot achieve its stated guarantee |
| `Economic / Incentive` | Every line correct; the incentives point at the vault |
| `Dependency` | Third-party code or supply chain |
| `Inconsistency` | Code, docs, and constants disagree — one of them is used |
| `Coding Style` | Readability and convention only |

## Finding ID

`{LAYER}-{NN}`, numbered in discovery order per layer, never reused:

`ANC` Anchor program · `API` backend and workers · `WEB` frontend ·
`ECO` economics · `CEN` centralization · `DEP` dependency ·
`CRY` cryptography · `OPS` deploy and infrastructure · `GLOBAL` cross-cutting

An ID is permanent. If a finding is withdrawn, keep the ID and mark it
`Withdrawn` with the reason — a report whose IDs are dense reads as edited.

## The finding block

Every finding, every time. Sections in this order, none omitted.

```markdown
### ANC-03 — Exploit payout re-reads a checkpoint the caller can reset

| | |
|---|---|
| **Severity** | Critical (Impact: Critical × Likelihood: Medium) |
| **Category** | Logical Issue |
| **Status** | Pending |
| **Location** | `packages/anchor/programs/covantic/src/instructions/verify_and_payout_exploit.rs:88-104` @ `a3f9c21` |

**Description**
What the code does, in the code's own terms, with the line that does it.

**Exploit path**
1. Attacker holds a policy for agent `A` with 100,000 USDC coverage.
2. Calls `checkpoint_balance` (permissionless) at time T with A's ATA full.
3. …
4. Vault transfers 100,000 USDC to the holder's ATA. Cost: 6.85 USDC premium.

**Impact**
Quantified. USDC at risk, who bears it, whether it is repeatable.

**Recommendation**
The specific change. Name the constraint, the check, or the ordering — not
"validate the input".

**Alleviation**
Filled at re-audit only. Empty until then.
```

Rules for the block:

- **Location is `file:line` at the frozen commit.** A range, not a file name.
- **Exploit path is mandatory for Critical and Major.** If you cannot write the
  numbered steps, you have a hypothesis. Either finish it or file it at the
  severity its evidence supports and say what is unproven.
- **Never write a recommendation you have not checked against the codebase.**
  Several obvious fixes here are wrong: `associated_token::authority` must not
  replace `address = get_associated_token_address(...)` on the governance path,
  because that path must read the account *after* an owner change.
- **Impact is arithmetic**, not adjectives, wherever money is involved.

## Status lifecycle

| Status | Meaning |
|---|---|
| `Pending` | Reported, no response yet |
| `Acknowledged` | Team accepts the finding, has not changed the code |
| `Resolved` | Fixed, and `remediation-verifier` re-derived the exploit path against the fix and it fails |
| `Partially Resolved` | Some vectors closed; name the ones still open |
| `Mitigated` | Code unchanged; an operational control reduces it. Name the control and who can remove it |
| `Declined` | Team disagrees or accepts the risk. Record their stated reason verbatim |
| `Withdrawn` | The auditor was wrong. Say why |

Only `remediation-verifier` moves a finding to `Resolved`, and only by
re-deriving the attack — never by reading the diff and finding it plausible.

## Deduplication

When several reviewers report overlapping issues:

1. **Same root cause → one finding**, at the highest severity any reviewer
   justified, listing every affected location.
2. **Same symptom, different root cause → separate findings.** A missing mint
   constraint and a missing owner constraint on the same struct are two bugs.
3. **A finding that is only reachable because of another** becomes a sub-case of
   the root finding, not its own entry — unless it is independently reachable.
4. Record the merge. The report's finding count is a number people compare.
