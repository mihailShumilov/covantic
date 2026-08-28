# Covantic Security Audit

| | |
|---|---|
| **Protocol** | Covantic — parametric insurance for AI agents on Solana |
| **Repository** | `ai-agent-insurance` |
| **Commit audited** | `<full 40-char hash>` |
| **Audit window** | `<YYYY-MM-DD>` – `<YYYY-MM-DD>` |
| **Report version** | `1.0` — Initial audit \| `2.0` — Re-audit of `<prior report>` |
| **Cluster reviewed** | devnet \| mainnet-beta |
| **Program ID** | `<program id>` |

---

## 1. Executive summary

`<One paragraph: what the protocol does and what it custodies.>`

### Findings

| Severity | Total | Resolved | Partially | Mitigated | Acknowledged | Declined | Pending |
|---|---|---|---|---|---|---|---|
| Critical | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Major | 0 | | | | | | |
| Medium | 0 | | | | | | |
| Minor | 0 | | | | | | |
| Informational | 0 | | | | | | |
| **Total** | **0** | | | | | | |

### Coverage

- In-scope files reviewed at depth L2 or better: `n / N`
- Settlement-path files reviewed at depth L3: `n / N`
- Files not covered: `<list, or "none">`
- Invariants proved by executable test: `n / N`

### What to act on first

1. `<ID>` — one line.
2. `<ID>` — one line.
3. `<ID>` — one line.

---

## 2. Scope

**Frozen at commit `<hash>`.** Findings reference line numbers at this commit.

| File | SHA-256 | LOC |
|---|---|---|
| | | |

**Out of scope:** `node_modules/`, `dist/`, generated IDL, `covantic-solana-sdk`,
third-party programs (SPL Token, Associated Token Account, Pyth).

**Assumed trusted:** the Solana runtime and validator set, the SPL Token
program, the Pyth guardian set, and the Postgres/Redis instances at their
network boundary.

---

## 3. Methodology

Phases executed, tools run with versions and invocations, specialist reviews
dispatched. Anything planned but not executed belongs in §11, not here.

---

## 4. Findings

Ordered Critical → Informational. One block each, per `finding-classification`.

### `<ID>` — `<title>`

| | |
|---|---|
| **Severity** | |
| **Category** | |
| **Status** | |
| **Location** | `path:line-line` @ `<commit8>` |

**Description**

**Exploit path**

**Impact**

**Recommendation**

**Alleviation**

---

## 5. Centralization and privilege

| Role | Key / authority | Can do | Worst case | Control today | Recommended |
|---|---|---|---|---|---|
| | | | | | |

Key custody, rotation, and exposure review. Upgrade-authority analysis.

---

## 6. Formal verification

| Invariant | Statement | Test | Result |
|---|---|---|---|
| `INV-SOLV-01` | | | Proved \| Falsified (`<ID>`) \| Asserted only |

---

## 7. Test coverage

## 8. Dependency and supply chain

## 9. Security scorecard

| Axis | Rating | Evidence |
|---|---|---|
| Code security | | |
| Centralization | | |
| Economic soundness | | |
| Operational resilience | | |
| Verifiability | | |

## 10. Limitations

What this audit does not establish.

## 11. Appendices

- A — Severity, category and status definitions
- B — Coverage matrix
- C — Tool versions and exact invocations
- D — Disclaimer
