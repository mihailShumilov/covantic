---
name: centralization-risk
description: Enumerate and price what privileged keys can do in Covantic — the oracle authority, the program upgrade authority, the config admin, the alert HMAC secret and the infrastructure operator — plus key custody, rotation, and the multisig/timelock control ladder. Load when auditing privilege and trust assumptions, writing the centralization section of an audit report, reviewing anything that adds or widens an authority, or before a mainnet deploy.
---

# Centralization and Privilege

Every finding in this section is a sentence of the form: **"the holder of key K
can do X, and nobody can stop them."** That is true of some key in every
protocol; the audit's job is to make the list complete and the consequences
explicit, not to pretend the list is empty.

This section is **mandatory in every report, including one with no
vulnerabilities.** A protocol with a live oracle authority and an upgrade
authority whose report does not name them is misleading by omission — and users
cannot discover these from the frontend.

## The question

Not "is this centralized?" — it is. Ask instead:

1. **What can this key take?** Bound it in USDC.
2. **What can this key break?** Denial of coverage counts. Refusing to sign a
   valid claim is a loss to the holder even though nothing was stolen.
3. **Who would notice?** Is there an event, a log, an indexer, a public PDA — or
   is the action invisible until the money is gone?
4. **Who could stop it?** A timelock, a multisig threshold, a guardian veto, or
   nothing.
5. **What happens if the key is lost, rather than stolen?** A protocol that
   bricks when the oracle keypair is lost is a finding too.

## The role table

The deliverable. One row per privileged key. No row may have an empty cell.

| Role | Key / authority | Can do | Worst case (USDC) | Detectable by | Control today | Recommended |
|---|---|---|---|---|---|---|
| Oracle authority | `<pubkey>` | Submit claims, drive settlement | Bounded by per-path proof; unbounded on `verify_and_payout` (legacy) | `ClaimSubmitted` event, policy PDA | Single hot keypair | 2-of-3 multisig; retire the legacy path |
| Upgrade authority | `<pubkey>` | Replace the program entirely | Full vault | On-chain, but only if watched | | Timelock, then burn for immutability |
| Config admin | `<pubkey>` | `update_config` — premiums, bounds, thresholds | | `ConfigUpdated` event | | Timelock on economic parameters |
| Alert HMAC holder | `ALERT_HMAC_SECRET` | Forge alerts into `monitoring:alerts` | Bounded by settlement proof | Nothing off-chain | env var on the server | Rotate; separate from deploy creds |
| Infra operator | server root | DB, Redis, all env secrets, the keeper | Everything the above can do, combined | | | Segregate deploy from key custody |
| Holder | their own keypair | Declare baselines and mandates, cause covered events | Priced by `protocol-economics-auditor` | On-chain declarations | | — |

Fill `<pubkey>` from the deployed config PDA, not from a script's default. They
have differed.

## Where to look

- `packages/anchor/programs/covantic/src/instructions/update_config.rs` and
  `initialize.rs` — who is stored as authority, and can it be changed?
- Every instruction with a `Signer` constraint — compare each against the stored
  authority, since `Signer` alone proves only that *somebody* signed.
- `solana program show <program-id>` — the live upgrade authority. Compare it to
  what the docs claim.
- The config PDA on chain — the live oracle authority and admin.
- `.env.example` and `docker/` — the names of every secret the operator holds.
  Never read live `.env`; enumerate the names and where they are used.
- `keys/` — check `git ls-files` for anything tracked. Untracked-but-present is
  an operational finding, not a code one; say which.

## The trust ladder

Recommend a rung, not "use a multisig". Each rung costs something; name it.

| Rung | Control | Cost |
|---|---|---|
| 0 | Single hot key | None. Assume compromise is total. |
| 1 | Single key, alerting on use | Detection only, no prevention |
| 2 | Multisig (2-of-3, 3-of-5) | Slower incident response; the keeper cannot sign autonomously |
| 3 | Multisig + timelock on economic params | Users get an exit window; emergencies get slower |
| 4 | Immutable program, authority burned | No fixes, ever. Only after the code is settled. |

For an automated claim keeper, rung 2 conflicts with autonomy — that tension is
itself a finding worth stating plainly, with the resolution being that the
*settlement proof*, not the key, is what bounds the loss.

## Bounded-by-proof is the real defence here

Covantic's design already answers most of the centralization question in code,
and the report should say so precisely rather than repeating a generic warning:

| Instruction | What the chain proves for itself | Oracle can extract |
|---|---|---|
| `verify_and_payout` | Nothing — trusts the submitted amount | Unbounded (legacy) |
| `verify_and_payout_v2` | A guardian-signed Pyth price, re-verified on chain | Bounded by the verified price |
| `verify_and_payout_exploit` | A balance drop measured against its own checkpoint | Bounded by the measured drop |
| `verify_and_payout_governance` | Control left a holder-declared set | Bounded by the declaration |

So: **the existence of the legacy path is the centralization finding**, and it
is a concrete one with a concrete fix, rather than "the oracle is trusted".
Check whether it is still reachable, whether anything still calls it, and what
gates it. Confirm the claim against the code at the audited commit — do not
copy this table forward.

## Off-chain privilege is still privilege

An auditor who stops at the program misses most of it:

- Whoever holds `ALERT_HMAC_SECRET` can inject alerts the keeper trusts.
- Whoever holds the DB can rewrite policy state the indexer will reconcile —
  and the indexer's `onConflictDoUpdate` overwriting on-chain-authoritative
  fields is what limits this. Verify that is still true; it is the control.
- Whoever holds the webhook bearer secret can feed the monitoring pipeline.
- Whoever can deploy can change all of the above without an on-chain trace.

Each is a row in the table with its own worst case and its own recommendation.

## Writing the findings

Centralization findings are priced with the same matrix as everything else, with
one adjustment: **likelihood is about key compromise or operator action, not
about protocol usage.** A single hot key that can drain the vault is
`Impact: Critical × Likelihood: Low` → **Major**, not Critical — unless the key
is stored somewhere that raises the likelihood, in which case say where and why.

Never file the whole category as one finding. "Centralization risks" as a single
entry is unactionable; one finding per key, per capability.
