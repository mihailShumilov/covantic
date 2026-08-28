---
name: security-audit
description: Full-surface, protocol-aware security audit of Covantic — the Anchor program, the claim pipeline, the API, the economics, and the deploy path. Use when asked to audit or security-review this repo, before enabling a proof flag, before a mainnet or production deploy, or after any change touching payouts, the vault, the oracle authority, coverage triggers, or holder declarations. Broader and more paranoid than the built-in /security-review, which looks only at the current branch diff.
---

# Covantic Security Audit

A staged audit for a protocol that custodies a USDC vault and pays claims
automatically. Scope the audit first, then work the layers in order of what an
attacker actually gets.

**This is not a generic web audit.** OWASP applies to one of five layers here.
The crown jewels are the vault balance, the oracle authority keypair, and the
integrity of the evidence a payout rests on.

> **When the output is a document somebody relies on** — a full audit, a
> pre-mainnet sign-off, a report with graded findings — use `audit-engagement`
> instead. It wraps this skill in scope freeze, coverage tracking, formal
> verification, centralization review, and a remediation loop. This skill stays
> the fast protocol-aware pass for a diff or a flag check, and remains the depth
> guide for the manual-review phase.

## Step 0 — Scope, and say so

Ask, or infer from the request, which of these you are doing:

| Scope | Trigger | Depth |
|---|---|---|
| **Change audit** | a diff, a PR, "review my changes" | Layers touched by the diff |
| **Pre-flag audit** | about to set a `*_PROOF_ENABLED` flag | Layers 1, 2, 4 + deploy preconditions |
| **Pre-deploy audit** | shipping to the server or mainnet | All five layers |
| **Full audit** | "audit the protocol" | All five, instruction by instruction |

State the scope in your report. An audit whose coverage is unstated reads as
complete when it was not.

## Step 1 — Read the ground truth before the code

Three files, in this order. They will save you from reporting things that are
deliberate:

1. `CLAUDE.md` → **Key Architectural Invariants.** Each entry is something that
   was got wrong once. A change that violates one is a finding.
2. `docs/{EXPLOIT,ORACLE_MANIPULATION,GOVERNANCE_ATTACK,AGENT_ERROR}_DETECTION.md`
   → §0 "What 100% proof can actually mean here" and the closing honest-summary
   section of each. The authors already name the boundary of each trigger. Your
   job is to check whether it still holds, not to rediscover it.
3. `shared/constants.ts` → the live numbers. **Never quote the README's tables;
   check whether they still match the code.** They have drifted before.

Then check the project memory of `paranoic-security-auditor`
(`.claude/agent-memory/`) for prior findings — **and verify each against current
code before repeating it.** Several are already fixed. A stale finding
re-reported as new destroys the signal of the whole report.

## Step 2 — Work the layers

Delegate the specialist layers rather than doing everything inline. Launch these
in parallel when the scope covers more than one:

### Layer 1 — On-chain program → `solana-program-auditor`

Account substitution, missing owner/mint/signer constraints, PDA seeds,
arithmetic, reinitialisation, payout bounds. The highest-severity findings in
this repo have all lived here.

### Layer 2 — Payout authorisation → inline, plus `claim-invariant-guard`

The chain of gates a payout passes through, each of which is load-bearing:

```
verdict → confidence lane → settlement plan → circuit breaker → instruction
          (ceiling 0.92     (proven_* or       (rolling cap)     (chain's own
           < 0.95 bar)       unprovable→review)                   bound)
```

Check every one of them. Specifically:
- Has any adjudicator's `CONFIDENCE_CEILING` risen toward 0.95?
- Can `planProvenSettlement` return `legacy` for a trigger that has a proof
  path? (Only `simulated` and a disabled flag may do that.)
- Does any payout path skip `checkCircuitBreaker`?
- Is the demo/synthetic verifier still gated on all three of `NODE_ENV`,
  cluster, and USDC mint?

### Layer 3 — Economics → `protocol-economics-auditor`

Moral hazard, self-dealing, adverse selection, solvency, oracle blast radius,
denial of coverage. Run this whenever a trigger, premium, bound or lock period
changes — a correct implementation of a wrong incentive still drains the vault.

### Layer 4 — API and infrastructure → `paranoic-security-auditor`

The generic checklist genuinely applies here. There is **no authentication on
any HTTP route by design**, so every route is externally reachable. Focus on:
- Input validation at every layer independently (Base58 address regex before
  any URL construction — SSRF into the Helius key has happened here).
- Webhook auth: HMAC of body, or bearer token, constant-time compared.
- Rate limits on routes that cause on-chain reads or expensive computation.
- The `monitoring:alerts` Redis channel is HMAC-signed; nothing may publish to
  it directly.

### Layer 5 — Secrets and deploy path → inline

- `git log -p --all -- .env` and `grep -rn "helius\|PRIVATE\|SECRET" --include=.env*`.
  A live key has been committed to this repo before.
- `keys/` handling, `scripts/deploy*.sh`, `docker/`.
- Migrations: any `--force` push against production is a finding.
- **Never run `anchor keys sync`** — it rewrites `declare_id!` and orphans the
  deployed program.

## Step 3 — Verify before reporting

Every finding needs a concrete path: who does what, with which input, and what
they walk away with. If you cannot write that sentence, label it a **suspicion**
and say what would confirm it.

Run what you can:

```bash
pnpm --filter api test          # 437 tests; the corpora are the real gate
cd packages/anchor && npx vitest run   # 56 bankrun integration tests
cd packages/anchor && cargo check
pnpm --filter api lint
```

For a program change, also `anchor build --no-idl --ignore-keys` — it catches
BPF stack-frame overflows that `cargo check` cannot see.

Report what you ran. An audit that asserts without executing is a review.

## Step 4 — Report

Order by expected loss, not by novelty.

```
## Scope
What was audited, what was not, and what was run.

## Findings
### [CRITICAL] <one-line claim>
**Where:** file:line
**Path:** actor → action → what they take
**Bound today:** the constant or check that limits it, or "none"
**Fix:** minimal change; a diff sketch for program code (do not apply it)
**If already deployed:** blast radius

## Checked and clean
The layers and invariants that held. This is what makes coverage legible.

## Accepted risks
Inherent to parametric insurance, not defects. Say so explicitly.
```

### Rules

- **One real finding beats twelve style notes.** Mixing them buries the one
  that matters.
- **Do not edit the Anchor program.** Report it. A wrong fix to a deployed
  program is worse than the finding, and any change needs a redeploy.
- **Distinguish "wrong" from "unreachable".** All four `*_PROOF_ENABLED` flags
  default false pending a redeploy. Code that is correct but switched off is a
  different finding from code that is wrong.
- **Say what is accepted.** Paying on a trigger rather than on proven loss is
  the product. The question is whether the trigger is bounded, not whether it
  can be caused deliberately.
- **Update the security memory** with genuinely new findings, and delete the
  ones you confirmed are fixed.
