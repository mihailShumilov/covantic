# Audit tooling

The security engagement layer: a staged audit process, the evidence and
severity discipline that goes with it, and two scripts that run.

The canonical files live here, under version control. Claude Code discovers
skills and agents only from `.claude/`, which is git-ignored by repo policy —
so `install.sh` symlinks these into place. What lands in `.claude/` is local
wiring, never a second copy to keep in step.

```bash
bash tools/audit/install.sh              # symlink into .claude/
bash tools/audit/install.sh --copy       # copy instead, if symlinks are awkward
bash tools/audit/install.sh --uninstall  # remove the links, leave other skills alone
```

Re-run after pulling if new skills or agents appear. The scripts run straight
from a fresh clone and need no install.

## Skills

| Skill | Role |
|---|---|
| `audit-engagement` | The playbook. Seven phases, each with an exit gate: scope freeze → threat model → automated sweep → specialist review → formal verification → centralization → report → remediation re-audit |
| `finding-classification` | Likelihood × Impact matrix, category taxonomy, finding IDs, status lifecycle, dedup rules, and severity calibration already settled for this protocol |
| `audit-report` | The deliverable, plus a report template |
| `formal-verification` | Seven invariants mapped onto the bankrun and vitest harnesses this repo already has |
| `static-analysis` | Toolchain, triage protocol, and a 14-pattern Solana/protocol grep checklist |
| `centralization-risk` | Privileged-role table, key custody, upgrade authority, trust ladder |

## Agents

| Agent | Surface |
|---|---|
| `audit-lead` | Scope, coverage matrix, dedup, severity arbitration, report assembly. Finds nothing itself |
| `crypto-signature-auditor` | HMAC alerts, Pyth guardian verification, evidence hashing, replay and domain separation |
| `centralization-risk-auditor` | What each privileged key can take, break, and who could stop it |
| `dependency-supply-chain-auditor` | Advisories with reachability established before severity |
| `formal-verification-engineer` | Turns asserted invariants into executable, mutation-proved tests |
| `remediation-verifier` | Re-derives each exploit path against the fix. The only agent that may mark a finding Resolved |
| `automated-scan-triage` | Runs the scanners, returns surviving leads, keeps tool output out of context |

These sit alongside the four protocol-specific auditors already in `.claude/agents/`
(`solana-program-auditor`, `protocol-economics-auditor`, `paranoic-security-auditor`,
`claim-invariant-guard`), which the engagement dispatches in its manual-review phase.

## Scripts

```bash
bash tools/audit/skills/static-analysis/scripts/audit-scope.sh  # commit + SHA-256 inventory
bash tools/audit/skills/static-analysis/scripts/audit-scan.sh   # clippy, advisories, secrets, greps
```

`audit-scan.sh` never aborts on a failing tool: anything missing is recorded as
**UNAVAILABLE** with its install line, because a silently skipped tool reads as
a clean scan. Output goes to `docs/audit/scan/`, which is git-ignored.

Two traps worth knowing if you extend the grep checklist:

- `rg` is absent from `PATH` in non-interactive shells. The fallback is
  `grep -rnE`; under plain BRE every `|` alternation matches literally and
  returns nothing, which looks exactly like a clean scan. Test new patterns
  under `bash`, not just your shell, and confirm a known-positive fires.
- `rg` uses the Rust regex engine, which has **no lookahead**. Enumerate
  alternatives instead.

## Reports

Findings and reports land in [`docs/audit/`](../../docs/audit) and are committed.
