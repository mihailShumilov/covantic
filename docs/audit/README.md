# Audit artefacts

Output of the security engagement tooling in [`tools/audit/`](../../tools/audit).

Run the scripts straight from a fresh clone. To make the skills and agents
loadable in Claude Code as well, run `bash tools/audit/install.sh` once — it
symlinks them into the git-ignored `.claude/`, which is the only place they are
discovered from.

| Path | Written by | Committed |
|---|---|---|
| `SCOPE.md` | `audit-scope.sh` | Yes — it is what a report's findings are pinned to |
| `AUDIT-{date}-{commit8}.md` | `audit-lead` | Yes |
| `scan/` | `audit-scan.sh` | No — regenerate it; raw tool output goes stale and can echo secrets |

## Running

```bash
bash tools/audit/skills/static-analysis/scripts/audit-scope.sh   # freeze scope (P0)
bash tools/audit/skills/static-analysis/scripts/audit-scan.sh    # automated sweep (P2)
```

Freeze scope on a clean working tree — `audit-scope.sh` warns when it is dirty,
because a scope nobody can reproduce is not a scope.

## Process

`audit-engagement` is the playbook: scope freeze → threat model → automated
sweep → specialist manual review → formal verification → centralization review
→ report → remediation re-audit. A re-audit is a **new** report file that
references the old one; superseded reports stay as a record of what was known
when.
