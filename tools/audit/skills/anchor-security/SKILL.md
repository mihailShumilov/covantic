---
name: anchor-security
description: Account-validation, arithmetic and authority checklist for writing or reviewing Anchor/Solana program code in packages/anchor. Load before adding or editing an instruction, an Accounts struct, a state account, a PDA seed, or a constant in the on-chain program — and before deciding an instruction is safe to deploy. Covers the bug classes that only exist on Solana, plus this program's own hard-won constraints.
---

# Anchor Program Security

The governing fact: **a program is handed a list of accounts by an untrusted
caller, and everything it believes about those accounts it must prove for
itself.** Anchor's `Account<'info, T>` checks only the program owner and the
discriminator. Everything else — who owns the token account, which mint it
holds, whether it is the *right* account — is yours to constrain.

## Account validation

For every account in an `Accounts` struct, write down what constrains it. An
account with no answer is the bug.

| Constraint | What it proves | When it is not enough |
|---|---|---|
| `seeds = [...] , bump` | The address is derived, not chosen | Seeds taken from an instruction *argument* are attacker-chosen |
| `address = <expr>` | Exactly this account | The expression must come from loaded state |
| `associated_token::mint / ::authority` | Canonical ATA of a given owner | Compiles to an **owner-equality check** — see below |
| `constraint = x.owner == y` | Token-account authority | Needed on every `TokenAccount` in a transfer path |
| `constraint = x.mint == config.usdc_mint` | The asset is the covered one | Omitting it accepts a worthless mint |
| `Signer<'info>` | Somebody signed | Says nothing about *who*; compare to stored authority |
| `has_one = holder` | Relationship between accounts | Only as good as the field it reads |

### `associated_token::authority` vs `address =` — a real trap here

`associated_token::authority = policy.agent_address` compiles into an owner
equality check. That means it **rejects an account whose owner has changed**.

- Correct on the exploit and agent-error paths: both describe something the
  agent did while still owning its account.
- Wrong on the governance path, which must read the covered account *precisely
  after a seizure*. Those instructions derive it with
  `address = get_associated_token_address(...)` instead, which still denies the
  caller a choice while allowing the owner to have changed.

Never "simplify" one into the other.

### Reinitialisation

`init_if_needed` on an account holding a running total, a previous value, or a
maturity timestamp is a reset primitive. Ask what a second call overwrites.
`init` on an evidence record is deliberate: one policy, one proven payout, and a
second attempt should fail loudly.

## Arithmetic

- `checked_add` / `checked_sub` / `checked_mul` / `checked_div`, mapped to
  `MathOverflow`. Bare operators are a finding.
- **`saturating_sub` is a decision.** It silently clamps to zero — correct for
  "how far past a bound did this land", wrong for vault bookkeeping, where
  clamping makes the token balance diverge from recorded state and corrupts the
  solvency ratio.
- Widen to `u128` before multiplying for basis points, then `try_from` back with
  the error mapped.
- Multiply before dividing; guard the divisor against zero.

## Authority, state, and time

- Check `config.paused` in anything that moves value. A pause some instructions
  ignore is a pause that does not work.
- Check the state machine: the required state going in, and advance it so the
  instruction cannot be replayed.
- Compare the signer against stored authority (`config.oracle_authority`,
  `policy.holder`) — not merely that a `Signer` exists.
- `Clock::get()` is the only clock. A timestamp from an argument is an
  attacker-chosen time.
- **Lock periods must be > 0** for every trigger. The lock is the window in
  which a human can pause the protocol if the oracle key is compromised.

### Staleness reference points

Checkpoint age is measured against `policy.claim_submitted_at` on the governance
and agent-error paths, and against `now` on the exploit path. That is not
inconsistency — it is arithmetic:

| Path | Lock | Allowance | Against `now`? |
|---|---|---|---|
| Exploit | 1 h | 2 h | works, with 1 h of slack — fragile |
| Governance | 2 h | 2 h | unsatisfiable |
| Agent error | 6 h | 2 h | unsatisfiable by 3× |

Ask "how stale was the reading when the incident happened", not "how long did
settlement take".

## Holder declarations

The only mechanism that puts *consent* on chain. Two rules make one worth
anything:

- **Holder-signed.** `policy.holder == signer.key()`, never the oracle. A
  declaration the operator could write puts the operator back in charge of the
  fact meant to constrain them.
- **Matures on a delay**, checked against `claim_submitted_at`. A declaration
  usable the instant it is written proves nothing.

Two traps that have both been hit:

- **`prev_*` on a first declaration must be zero.** The fallback exists so a
  refresh landing after the incident does not erase the only usable "before".
  Seeding a *new* declaration's predecessor with its own values and `now` — the
  natural-looking thing to write — makes it usable immediately and silently
  disables the entire delay.
- **The zero `Pubkey` must never read as permitted.** Every unset slot in a
  fixed-size allowlist is zero; carry an explicit count and reject
  `Pubkey::default()` at declare time.

## Payout instructions

Every one must answer: **what upper bound did the program derive for itself?**

- `payout_amount <= policy.coverage_amount` alone is the *legacy* guarantee. It
  means the oracle chose the number.
- A proven path bounds by something measured: a verified price, a measured drop,
  an observed departure, an overshoot past a declared cap.
- The loss cascade — treasury → reserve → staker principal — must stay in step
  across every payout path, or solvency drifts.
- Commit `bundle_hash` to an evidence record and emit the proof event. Their
  presence, not a flag being set, is what separates a payout the chain checked
  from one it merely permitted.

## Build and layout

- `LEN` must match the struct field for field, including the 8-byte
  discriminator.
- `anchor build --no-idl --ignore-keys` is the cheap check `cargo check` cannot
  replace: it catches **BPF stack-frame overflows in `try_accounts`**. Box the
  account structs when it complains.
- `--ignore-keys` is mandatory in this repo: `target/deploy/covantic-keypair.json`
  does not match `declare_id!`.
- **Never run `anchor keys sync`.** It rewrites `declare_id!` and orphans the
  deployed program.
- The IDL at `packages/anchor/target/idl/covantic.json` is versioned and read at
  runtime by the API and monitor. Rebuild it (`anchor build --ignore-keys`, not
  `--no-idl`) when instructions change, or clients call a function that is not
  there.

## Testing

Integration tests run under `solana-bankrun` — no validator needed:

```bash
cd packages/anchor && npx vitest run
```

For a new instruction, cover: the happy path; each `require!` refusing; the
account-substitution attempt; the boundary values (zero, equal, one past); and
"only once" for anything that must not be replayable. Clock manipulation is
`advanceClockBySeconds(context, n)`.
