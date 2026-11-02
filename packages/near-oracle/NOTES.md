# Verified facts

Checked on 2026-11-02 against live testnet state and current sources. "Live" means observed directly
on the network, not read from documentation.

## Chain Signatures

| Fact | Value | Source |
| --- | --- | --- |
| Testnet MPC contract | `v1.signer-prod.testnet`, version `3.18.0` | Live: `version` view; [docs](https://docs.near.org/chain-abstraction/chain-signatures/implementation) |
| Mainnet MPC contract | `v1.signer` | [docs](https://docs.near.org/chain-abstraction/chain-signatures/implementation) |
| Domain for Ed25519 | `1` (protocol `Frost`, purpose `Sign`) | Live: `state` view |
| Reconstruction threshold | 11 | Live: `state` view |
| Derived key | `derived_public_key({ path, predecessor, domain_id })` | Live, used by the spike |
| Solana address | The derived Ed25519 public key, base58 | Live: signature verifies against it |
| Sign arguments | `{ request: { payload_v2: { Eddsa: <hex> }, path, domain_id } }` | [near/mpc contract README](https://github.com/near/mpc/blob/main/crates/contract/README.md); live |
| Eddsa payload size | 32 to 1232 bytes | [near/mpc contract README](https://github.com/near/mpc/blob/main/crates/contract/README.md) |
| Deposit | At least 1 yoctoNEAR, excess refunded | [near/mpc contract README](https://github.com/near/mpc/blob/main/crates/contract/README.md) |
| Gas | At least 10 Tgas required, about 7 Tgas used | [near/mpc contract README](https://github.com/near/mpc/blob/main/crates/contract/README.md) |
| Response | `{ scheme: 'Ed25519', signature: number[64] }` | Live, not documented in the README |

The payload is the raw Solana message, not a hash of it. An agent contract calling `sign` becomes the
predecessor, so ADDR is derived from the contract id, not from the worker's account. The spike address
is therefore not the production address.

## Spike measurements

Dry runs against `v1.signer-prod.testnet` on 2026-11-02, called directly from a testnet account.

| Message | Runs | Sign time | Blocks consumed of about 150 |
| --- | --- | --- | --- |
| 163 bytes | 3 | 4.8 to 5.6 s | 22 to 24 |
| 1064 bytes | 2 | 5.4 to 5.6 s | 23 to 24 |

Size has no visible effect. Signing uses about 16% of blockhash validity, so a durable nonce is not
needed on this evidence. The path through the agent contract adds a hop and has not been measured.

## Shade Agent framework

- Status: the docs say it stops being maintained as standalone tooling after 2026-04-19 and stays open
  source. See the [notice](https://docs.near.org/ai/shade-agents/getting-started/introduction). The
  [monorepo](https://github.com/NearDeFi/shade-agent-framework) last received a push on 2026-10-14.
- The monorepo states the framework has not had a formal audit. Earlier docs also warn against
  production use.
- Packages: `@neardefi/shade-agent-js` 2.2.0, `@neardefi/shade-agent-cli` 2.4.0, and the
  `shade-attestation` crate. The unscoped `shade-agent-js` name does not exist on npm.
- [Agent contract](https://github.com/NearDeFi/shade-agent-framework/blob/main/docs/reference/agent-contract.md):
  `new(requires_tee, attestation_expiration_time_ms, owner_id, mpc_contract_id)`,
  `approve_measurements`, `approve_ppids`, and `register_agent(attestation)` with a deposit of 0.00486
  NEAR.
- Local mode: `requires_tee = false` plus `whitelist_agent_for_local`. The contract cannot verify code
  in this mode.
- Terms: the framework approves measurements and PPIDs, which is what the spec calls an approved code
  hash.
- [Security notes](https://github.com/NearDeFi/shade-agent-framework/blob/main/docs/concepts/security.md):
  TEE.fail can extract secrets from TDX with physical access. Agent contract access keys should be
  removed before production. A signature may succeed while its transaction fails, so retries must be
  designed in.
- The docs recommend guardrails in the contract, which is what SPEC section 5 does.

## Access keys

From [the access keys page](https://docs.near.org/protocol/accounts-contracts/access-keys):

- A function-call key can call one `receiver_id`, optionally restricted to listed `method_names`.
- It cannot attach a deposit, so it cannot transfer NEAR.
- `allowance` caps gas spending. Once spent, the key cannot sign, and topping up the account does not
  restore it because the allowance belongs to the key and cannot be changed.
- An account with only function-call keys cannot transfer NEAR, delete itself or manage keys.

The deposit restriction conflicts with two calls. `register_agent` needs a deposit, and any contract
method that attaches a deposit to `sign` must fund it from the contract's balance, not the caller's.

## near-sdk and tooling

- `near-sdk` 5.30.0 is the current crate per `cargo search`. Contract test tooling is not yet verified.
- `near-api-js` 7.4.0 and `chainsig.js` 1.1.16 are current on npm. The spike uses near-api-js only.
- Local: Rust 1.98, `wasm32-unknown-unknown` installed. `cargo-near`, `near` CLI and
  `shade-agent-cli` are not installed.

## Foreign-chain verification (stretch only)

The testnet MPC has a `ForeignTx` domain, id `3`, and the contract README documents
`verify_foreign_transaction`. Whether Solana is in the supported set on testnet is not confirmed.

## Pyth

- Hermes [now requires an API key](https://docs.pyth.network/price-feeds/core/api-reference).
  `hermes.pyth.network`, `pyth.dourolabs.app/hermes` and `hermes-beta.pyth.network` all answered 401
  on 2026-11-02.
- Per the [upgrade guide](https://docs.pyth.network/price-feeds/core/upgrade/preparing), keys come
  from Pyth Terminal with a free trial and paid plans. Trial limits are not verified.
- The devnet receiver `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` is active, with writes seconds
  apart.
- A live push account cannot serve as evidence. `verify_and_payout_v2` requires `publish_time` within
  `MAX_PRICE_EVIDENCE_SKEW` (5 s) of a trigger time that precedes the claim, and the 30 s lock passes
  before payout. It needs a dedicated update for that moment, which means Hermes.

## Solana devnet

- The RPC faucet is closed: `requestAirdrop` answers 410 and points to https://faucet.solana.com.
  Scripts cannot fund addresses themselves, so `derive-address` must say so.

## Open design points

- `upsert_attestation` is oracle-only and `create_policy` requires it, but guardrail 4 does not allow
  it. After the switch nobody can sign an attestation, so a fresh policy cannot be bought.
- Guardrail 5 marks a policy at signing time. A signature whose transaction then fails would burn the
  policy's only payout, so a bounded re-sign rule is needed.
- Guardrail 6 uses declared coverage. The contract cannot read Solana, so the value is worker-supplied.
  `payout_amount` is in the instruction data and can be parsed instead.
- The contract cannot judge blockhash age, so a signed message stays valid for its blockhash lifetime.
