# Coverage Matrix Template

Fill one row per in-scope file. The matrix is a deliverable — it ships in the
report appendix. A file with no reviewer is not a quiet omission; it is a
declared coverage gap.

| File | SHA-256 (first 8) | LOC | Reviewers | Automated | Invariant tests | Findings |
|---|---|---|---|---|---|---|
| `packages/anchor/programs/covantic/src/instructions/verify_and_payout_exploit.rs` | `a3f9c210` | 184 | solana-program-auditor, crypto-signature-auditor | clippy, semgrep | INV-SOLV-01, INV-PAY-02 | ANC-03 |
| `packages/api/src/services/exploit/adjudicate.ts` | `7b1e04dd` | 262 | claim-invariant-guard, protocol-economics-auditor | eslint, semgrep | INV-DET-01 | — |
| `packages/api/src/routes/monitoring.ts` | `c0d4a71f` | 97 | paranoic-security-auditor, crypto-signature-auditor | semgrep, gitleaks | — | API-01, API-04 |

## Depth codes

Record the depth actually reached, not the intent.

| Code | Meaning |
|---|---|
| `L1` | Read in full, line by line, against the relevant checklist |
| `L2` | L1 + every caller and callee traced across the boundary |
| `L3` | L2 + executable invariant or exploit attempt written |
| `S` | Skimmed for a specific pattern only — name the pattern |
| `A` | Automated tooling only — no human read |
| `—` | Not covered. Must appear in the report's limitations section. |

Anything in the settlement path (`verify_and_payout*`, the vault, the oracle
authority, the alert channel) that is below `L3` is itself worth reporting as a
coverage limitation.

## Rollup

State these three numbers in the executive summary:

- In-scope files covered at `L2` or better: `n / N`
- Settlement-path files covered at `L3`: `n / N`
- Files not covered: list them, do not count them
