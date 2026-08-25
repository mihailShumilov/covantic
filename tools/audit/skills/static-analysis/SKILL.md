---
name: static-analysis
description: The automated security toolchain for Covantic — clippy security lints, cargo-audit, cargo-deny, pnpm audit, osv-scanner, semgrep, gitleaks, hadolint, and the Solana/protocol grep checklist — plus the triage protocol that turns tool output into leads without letting it become findings. Load before running any automated security scan, when triaging scanner output, or during phase P2 of an audit engagement.
---

# Automated Sweep

Tools find the bugs that have names. None of the bugs that matter in this
protocol have names — account substitution, a payout measured against a
resettable checkpoint, a premium that makes self-dealing profitable. Run the
tools anyway: they are cheap, they clear the floor, and an unrun tool is a
coverage gap you will have to declare in the report.

## Running it

```bash
bash tools/audit/skills/static-analysis/scripts/audit-scan.sh            # full
bash tools/audit/skills/static-analysis/scripts/audit-scan.sh --quick    # skips repo-wide tsc
```

Writes `docs/audit/scan/` with one artefact per tool and a `SUMMARY.md` table.
The script never aborts on a failing tool — a tool that is missing is recorded
as **UNAVAILABLE** with its install command, because a silent skip becomes a
false claim of coverage.

Dispatch `automated-scan-triage` to run this and return only surviving leads.
Raw scanner output in the engagement context is noise that crowds out reading.

## Toolchain

Installed here today: `cargo`, `cargo clippy`, `cargo-audit`, `rg`, `jq`.
Everything below that is missing is worth installing before a real engagement —
the script prints each one's install line.

| Tool | Catches | Install |
|---|---|---|
| `cargo clippy` (security lints) | arithmetic side effects, `unwrap`/`panic` in program code, truncating casts, indexing | `rustup component add clippy` |
| `cargo-audit` | RustSec advisories in the Anchor dependency tree | `cargo install cargo-audit` |
| `cargo-deny` | unmaintained crates, licence issues, duplicate/banned versions | `cargo install cargo-deny` |
| `pnpm audit` | npm advisories across the workspace | bundled |
| `osv-scanner` | both lockfiles against OSV, wider than either native tool | `brew install osv-scanner` |
| `semgrep` | injection, taint, secret and OWASP patterns in TS and Rust | `brew install semgrep` |
| `gitleaks` | secrets in **full git history**, not just the working tree | `brew install gitleaks` |
| `hadolint` | Dockerfile hardening | `brew install hadolint` |
| `tsc --noEmit` | type errors that mask real logic bugs | bundled |

The clippy invocation matters more than the tool. Bare `cargo clippy` is a style
run; the script enables `arithmetic_side_effects`, `unwrap_used`, `expect_used`,
`panic`, `indexing_slicing` and `cast_possible_truncation`, which are the lints
that correspond to on-chain failure.

## The grep checklist

Fourteen mechanical patterns run unconditionally, into
`docs/audit/scan/grep-checklist.md`. They encode this codebase's own history:

- **G01 raw `AccountInfo`/`UncheckedAccount`** — each one is a place the program
  believes something it has not proved. Every hit needs a written justification.
- **G03 `init_if_needed`** — on an account holding a running total or a previous
  value this is a reinitialisation bug, and the baseline it resets is what a
  payout is measured against.
- **G07 impurity in adjudicators** — must return nothing. `Date.now()`,
  `Math.random()`, `new Date()` or I/O in `services/*/adjudicate.ts` breaks
  `claim:replay` and the on-chain evidence hash.
- **G08 the confidence gap** — `CONFIDENCE_CEILING` (0.92) must stay below
  `AUTO_PAY_CONFIDENCE` (0.95). That gap is the guarantee that off-chain
  analysis alone cannot release funds.
- **G13 Helius cluster hosts** — Enhanced Transactions are cluster-partitioned.
  The wrong cluster returns `[]` rather than an error, which silently breaks
  every verifier's trigger lookup. The retired `api.helius.xyz/v0` host must not
  reappear.

Extend the list when an audit finds a bug that a grep would have caught. That is
the point of it. Two rules when you do:

- **Scope the pattern to the invariant.** G07 binds the four `adjudicate.ts`
  files, not all of `services/` — a check that fires on legitimate code every
  run is a check people learn to skip.
- **The `grep` fallback is `-E`.** `rg` is absent from `PATH` in non-interactive
  shells, and under plain BRE `grep` every `|` alternation matches literally and
  returns nothing — which reads exactly like a clean scan. This bit this script
  once; nine of fourteen checks were silently dead. If you add a pattern, run it
  through `bash` and not just your shell, and confirm a known-positive fires.
  `rg` also uses the Rust regex engine, which has **no lookahead** — enumerate
  alternatives instead.

## Triage protocol

**Every hit is a lead. No tool output reaches a report as a finding.**

For each hit, do one of exactly two things and record which:

1. **Promote** — read the code, establish reachability, write the exploit path,
   then price it with `finding-classification`. The finding cites the code, not
   the scanner.
2. **Dismiss** — with a reason. "Unreachable: the caller validates at
   `routes/x.ts:42`" is a reason. "False positive" is not.

Order the queue by where the money is, not by the tool's own severity:

1. Anything in `packages/anchor/programs/` — the program spends the vault.
2. Anything on the claim path — webhook ingress, alert channel, keeper,
   adjudicators, settlement.
3. Secrets, in history as well as HEAD.
4. Dependency advisories that are actually reachable from called code.
5. Everything else.

### Known-benign, do not re-report

Check against these before promoting. Each is deliberate and documented:

- `associated_token::authority` on the exploit and agent-error paths, versus
  `address = get_associated_token_address(...)` on the governance path. The
  difference is required — governance must read the account *after* an owner
  change. Never "unify" them.
- `balance_drop_unexplained` is intentionally unmapped in `EVENT_TO_TRIGGER`.
- `/api/monitoring/webhook` accepting a bearer token as well as an HMAC — real
  Helius deliveries are not HMAC-signed.
- `checkpoint_balance` being permissionless — it records what the program reads
  for itself, and the payout instruction re-reads it.
- `https://api.helius.xyz/v0/webhooks` in `services/helius-webhook.ts`. The
  retired-host invariant is about **Enhanced Transactions**, which are
  cluster-partitioned and correctly routed through `resolveHeliusBaseUrl` in
  `utils/helius.ts`. Webhook *management* is a different API and legitimately
  lives on that host. G13 is scoped to exclude it — do not widen it back.
- `Date.now()` appearing inside a *comment* in `services/oracle/adjudicate.ts`,
  which documents the purity contract rather than breaking it.

A finding that contradicts `CLAUDE.md` → Key Architectural Invariants without
addressing the reasoning there is a false positive, and costs the report more
than the finding was worth.

## Dependency advisories

Reachability decides severity. An advisory in a transitive dev dependency that
never runs in production is `Informational`; the same CVSS in a crate the
program links is not. State which one you established and how — the call path,
or the fact that you could not find one.

For Anchor, version coupling is itself a security property: `pyth-solana-receiver-sdk`
2.x builds against `anchor-lang` 1.0.2, and bumping one alone pulls two
incompatible `solana-program` versions into one binary. Treat a dependency bump
here as a change requiring the full program review, not a chore.
