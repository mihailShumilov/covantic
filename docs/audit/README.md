# Audit artefacts

Output of the security engagement tooling in `.claude/skills/`.

> `.claude/` is git-ignored by repo policy (`.gitignore:24`), so the skills,
> agents and scripts referenced below are **not** in a fresh clone. The reports
> in this directory are committed and stand on their own; regenerating the scan
> artefacts requires that local tooling.

| Path | Written by | Committed |
|---|---|---|
| `SCOPE.md` | `audit-scope.sh` | Yes — it is what a report's findings are pinned to |
| `AUDIT-{date}-{commit8}.md` | `audit-lead` | Yes |
| `scan/` | `audit-scan.sh` | No — regenerate it; raw tool output goes stale and can echo secrets |

## Running

```bash
bash .claude/skills/static-analysis/scripts/audit-scope.sh   # freeze scope (P0)
bash .claude/skills/static-analysis/scripts/audit-scan.sh    # automated sweep (P2)
```

Freeze scope on a clean working tree — `audit-scope.sh` warns when it is dirty,
because a scope nobody can reproduce is not a scope.

## Process

`audit-engagement` is the playbook: scope freeze → threat model → automated
sweep → specialist manual review → formal verification → centralization review
→ report → remediation re-audit. A re-audit is a **new** report file that
references the old one; superseded reports stay as a record of what was known
when.
