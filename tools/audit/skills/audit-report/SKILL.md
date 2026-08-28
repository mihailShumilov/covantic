---
name: audit-report
description: Assemble the audit deliverable to third-party-audit-firm standard — executive summary, scope table with file hashes, methodology, findings by severity, centralization section, formal-verification results, security scorecard, limitations, and appendices. Load when writing, reviewing or updating an audit report, a re-audit report, a pre-mainnet security sign-off, or a public-facing security summary. Findings must already be priced with `finding-classification`.
---

# Writing the Audit Report

The report is read by two people: an engineer who will fix things, and someone
deciding whether to put money in. Both are badly served by hedging.

Write it to `docs/audit/AUDIT-{YYYY-MM-DD}-{commit8}.md`. A re-audit is a new
file that references the old one, never an edit of it — the superseded report
stays as a record of what was known when.

Start from `references/report-template.md`.

## The rules that make it an audit

**State coverage before findings.** A reader who does not know what was looked
at cannot interpret an empty findings list. Scope, hashes and the coverage
rollup come before the first finding.

**Never write "no vulnerabilities were found."** Write what was examined, to
what depth, and that no findings of severity X or above arose from it. The first
sentence is a promise about the code; the second is a true statement about the
audit.

**Limitations are load-bearing.** Unrun tools, unreviewed files, invariants
asserted but not proved, anything that could only be checked on devnet. This
section is what lets a reader trust the rest, so it goes in the body, not an
appendix.

**No marketing language.** No "robust", "battle-tested", "military-grade",
"fully secure". If a control is good, describe what it prevents. The word
"audited" is not a security property.

**Every claim traceable.** Findings quote `file:line` at the frozen commit.
Statements about behaviour name the file that produces it. Numbers come from
`shared/constants.ts`, never from the README.

**Centralization is a mandatory section**, even at zero findings. A report on a
protocol with a live oracle authority and an upgrade authority that does not
enumerate them is misleading by omission.

## Structure

1. **Cover** — protocol, repository, commit hash, audit window, auditor,
   report version, and whether this is an initial audit or a re-audit.
2. **Executive summary** — one paragraph of what the protocol does; the
   findings table by severity and status; the coverage rollup; the three things
   most worth acting on. No more than a page.
3. **Scope** — in-scope inventory with SHA-256, out-of-scope list, assumed-trusted
   components, and the frozen commit.
4. **Methodology** — the phases actually executed, tools actually run, and
   specialist reviews actually dispatched. Anything skipped moves to Limitations.
5. **Findings** — Critical → Major → Medium → Minor → Informational, each in the
   block from `finding-classification`.
6. **Centralization and privilege** — the role table from `centralization-risk`,
   the key custody review, the upgrade-authority analysis, and the recommended
   control ladder.
7. **Formal verification** — each invariant, its executable test, and its
   result: proved, falsified (→ a finding), or asserted-only. An invariant
   listed without a test is a claim, and must say so.
8. **Test coverage** — what the suite covers, notably the settlement paths and
   the labelled detection corpora, with the numbers.
9. **Dependency and supply chain** — advisories by severity, unpinned or
   unaudited transitive risk, build provenance.
10. **Security scorecard** — see below.
11. **Limitations** — what this audit does not establish.
12. **Appendices** — severity definitions, category definitions, status
    definitions, coverage matrix, tool versions and invocations, disclaimer.

## The scorecard

Five axes, each scored `Strong / Adequate / Weak / Critical Gap`, each with one
sentence of evidence pointing at code or a finding ID. Prose only — do not
invent a numeric score, which reads as precision the method does not have.

| Axis | Question |
|---|---|
| **Code security** | Do the on-chain paths prove what they spend for themselves? |
| **Centralization** | What can privileged keys take, and who can stop them? |
| **Economic soundness** | Can a participant profit by causing a covered event? |
| **Operational resilience** | Key custody, deploy path, monitoring, incident response |
| **Verifiability** | Can a third party re-derive a payout from committed evidence? |

## Disclaimer

Every report ends with it, and it is not boilerplate to skim:

> This report reflects the state of the reviewed code at commit `<hash>` and the
> scope stated above. It is not a guarantee of security, an endorsement of the
> protocol or its economics, financial advice, or a statement about code outside
> the frozen scope — including later changes, deployment configuration, the
> keys in operational use, and third-party programs and services the protocol
> depends on. Detection of an adaptive adversary is an open-world problem; no
> audit establishes completeness of coverage.

## Re-audit reports

A re-audit report keeps every original finding ID, adds the new commit hash, and
gives each finding a filled **Alleviation** section with the status assigned by
`remediation-verifier`. New findings introduced by the fixes are numbered in the
original layer sequence and marked as regressions. Report the counts both ways:
originals by final status, and new findings by severity.
