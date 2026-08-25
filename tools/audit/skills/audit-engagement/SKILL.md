---
name: audit-engagement
description: The full third-party-audit-firm engagement standard for Covantic — scope freeze with file hashes, threat model, automated sweep, specialist manual review, formal verification, centralization review, graded report, and remediation re-audit. Load when asked for a "full audit", "professional audit", "CertiK-level audit", an audit report, a pre-mainnet sign-off, or a re-audit of fixes. This is the process layer; `security-audit` remains the fast protocol-aware pass for a single change.
---

# Audit Engagement Standard

A named engagement, not a code review. The difference is not depth of reading —
it is that an engagement **states its own coverage, prices every finding, and
can be re-run against the same commit to the same conclusions.**

Use `security-audit` for a diff or a pre-flag check. Use this when the output is
a document somebody will rely on to move real money.

## What separates this from a review

Five properties. If a report lacks any of them it is a review with a cover page.

1. **Frozen scope.** One commit hash. Every in-scope file listed with its
   SHA-256. Everything else explicitly named out of scope.
2. **Stated coverage.** A matrix of in-scope files × who reviewed them. Silence
   about a file is a claim it was covered — so never be silent.
3. **Priced findings.** Severity from the Likelihood × Impact matrix in
   `finding-classification`, never from vibes. Every Critical/Major carries a
   concrete exploit path.
4. **Machine-checked invariants.** At least the solvency and authorization
   invariants proved by executable tests, not by argument. See
   `formal-verification`.
5. **A remediation loop.** Each finding ends in Resolved / Partially Resolved /
   Mitigated / Acknowledged / Declined, verified by re-reading the fix at a new
   commit — not by trusting the fixer.

## Phases

Work them in order. Each has an exit gate; do not carry an unmet gate forward
silently — report it as a coverage limitation instead.

### P0 — Scope freeze

Run `bash tools/audit/skills/static-analysis/scripts/audit-scope.sh`. It emits the commit hash,
the in-scope file inventory with SHA-256 digests, and LOC counts.

Decide and write down:

| | |
|---|---|
| In scope | usually `packages/anchor/programs/`, `packages/api/src/`, `packages/shared/`, `packages/web/src/`, `docker/`, `scripts/` |
| Out of scope | `node_modules`, generated IDL, `dist/`, third-party programs (SPL Token, Pyth), the Solana runtime itself, `covantic-solana-sdk` unless asked |
| Assumed-trusted | the Solana validator set, the SPL Token program, Pyth's guardian set, Postgres/Redis at their trust boundary |

**Gate:** a commit hash and a file inventory exist. Findings quote `file:line`
at *this* commit and nowhere else.

### P1 — Threat model

Before reading code for bugs, write down what an attacker wins.

- **Crown jewels.** The vault USDC balance. The oracle authority keypair. The
  program upgrade authority. `ALERT_HMAC_SECRET`. The integrity of evidence a
  payout rests on.
- **Actors.** Anonymous internet. Policyholder (controls their own agent —
  assume they read this repo). Staker. Oracle operator. Helius. Infrastructure
  operator with server access. A compromised dependency.
- **Trust boundaries.** Every one of these is a place to enumerate: webhook
  ingress → API; API → Redis `monitoring:alerts`; keeper → chain; adjudicator →
  settlement instruction; browser → API; operator → upgrade authority.
- **Attack trees.** For each crown jewel, root the tree at "attacker holds it"
  and expand until every leaf is either a control you can point at in code, or a
  finding.

**Gate:** every crown jewel has a tree whose leaves are all controls or
findings. A leaf that is "we assume nobody does this" is a finding.

### P2 — Automated sweep

Load `static-analysis` and run
`bash tools/audit/skills/static-analysis/scripts/audit-scan.sh`. Dispatch
`automated-scan-triage` so tool output does not land in the engagement context.

**Gate:** every tool either ran or is recorded as unavailable with the reason.
An unrun tool is a coverage gap, not a pass. Every surviving hit is either
promoted to a lead for P3 or dismissed with a reason.

### P3 — Manual specialist review

The automated sweep finds none of the bugs that matter here. Dispatch these,
in parallel where their surfaces do not overlap:

| Agent | Surface |
|---|---|
| `solana-program-auditor` | `packages/anchor/programs/` — account validation, seeds, arithmetic, authority |
| `crypto-signature-auditor` | HMAC alerts, Pyth guardian verification, evidence hashing, replay/nonce/domain separation |
| `paranoic-security-auditor` | API, workers, web, Docker, secrets, OWASP surface |
| `protocol-economics-auditor` | moral hazard, self-dealing, adverse selection, solvency drain |
| `centralization-risk-auditor` | privileged roles, keys, upgrade authority, operator trust |
| `dependency-supply-chain-auditor` | lockfiles, RustSec/npm advisories, build and CI provenance |
| `claim-invariant-guard` | the written invariants in `CLAUDE.md` and the claim pipeline |
| `formal-verification-engineer` | executable invariants (also P4) |

Then dispatch `audit-lead` to dedupe, arbitrate severity, and build the
coverage matrix. Two agents reporting the same root cause is one finding.

**Gate:** every in-scope file appears in the coverage matrix with at least one
reviewer. Files nobody reviewed are listed in the report as uncovered.

### P4 — Formal verification

Load `formal-verification`. At minimum, executable proofs for:

- **Solvency** — vault lamports/token balance ≥ sum of obligations, after every
  instruction sequence.
- **Conservation** — no instruction mints, burns, or strands vault USDC.
- **Authorization** — no settlement path releases funds without the chain's own
  check; the `CONFIDENCE_CEILING` < `AUTO_PAY_CONFIDENCE` gap holds in code.
- **Determinism** — `adjudicate(bundle)` is pure; replay reproduces every stored
  verdict.
- **State machine** — no policy or claim reaches a terminal state twice; no
  double payout.

**Gate:** each invariant is a test that fails when you deliberately break the
code it protects. An invariant test that passes against a broken build proves
nothing — mutate and confirm.

### P5 — Centralization and operations

Load `centralization-risk`. Produce the privileged-role table, the key custody
review, and the upgrade-authority analysis. This section is mandatory even when
it contains no "vulnerability" — an audit that omits it is misleading about who
can take the money.

**Gate:** every privileged key is named with its current control and its
recommended control.

### P6 — Report

Load `audit-report`. Assemble. Do not begin writing before P0–P5 gates are
recorded, because the report's honesty depends on stating which ones were not
met.

### P7 — Remediation re-audit

When fixes land, dispatch `remediation-verifier` against the new commit. It
re-derives the exploit path rather than reading the diff for good intentions,
and checks whether the fix introduced anything new. Only it may move a finding
to Resolved.

## Standing rules

- **No finding without a path.** Critical and Major require a concrete
  sequence: these accounts, this order, this profit. If you cannot write it,
  the severity is not Critical — or the finding is not real.
- **Quantify in USDC and time.** "Moral hazard exists" is not a finding.
  "6.85 USDC premium against a 100,000 USDC payout on a 24h policy" is.
- **Read `CLAUDE.md` → Key Architectural Invariants first.** Each entry was got
  wrong once. Several things that look like bugs are deliberate and documented;
  reporting them as findings costs the report its credibility.
- **Check `shared/constants.ts` for live numbers.** Never quote the README's
  tables — they have drifted.
- **Verify prior findings before repeating them.** `.claude/agent-memory/` holds
  earlier results; the code has moved since.
- **State what you did not do.** Unrun tools, unreviewed files, invariants not
  proved. A limitations section is what makes the rest believable.
