# Task list

Last updated 2026-11-02.

## Done

- [x] Day-1 spike: address derived, MPC signing measured, memo transactions landed on devnet
- [x] Owner decisions: this branch, `upsert_attestation` allowed, `update_config` just before recording
- [x] `pre-hackathon` tag on `fc4e4ad` (local, not pushed), MIT LICENSE at the repo root
- [x] NEAR contract with guardrails, typed errors and tests, deployed to testnet
- [x] Agent: watcher, predicate over the baseline adjudicator, tx builder, signing, broadcast, evidence
- [x] Scripts: near:deploy, derive-address, admin:set-oracle, demo:guardrail
- [x] Vitest suite: predicate, baseline isolation, transaction parity

## Written, not yet run end to end

- [ ] `demo:false-positive --live`, then commit `fixtures/false-positive.json`. Needs a funded funder
- [ ] `demo:payout`. Needs a funded funder, a funded oracle, a Pyth key and `update_config`

## Waiting on the owner

- [ ] Fund the funder (see `pnpm funder`) with SOL and mock USDC
- [ ] Provide `PYTH_HERMES_API_KEY`
- [ ] Run `pnpm admin:set-oracle` just before recording
- [ ] Phala account and an image registry for the TEE deployment
- [ ] Push the `pre-hackathon` tag and the branch

## Next stages

- [ ] Shade Agent TEE deployment on Phala, local mode kept runnable.
      `@neardefi/shade-agent-js` fails to load under Node here: its `@phala/dstack-sdk`
      resolves `@noble/hashes` 2.x, which has no `./sha3` path. Local mode avoids it with a
      lazy import. TEE mode needs a dependency fix.
- [ ] Docs: README, ARCHITECTURE, root README section
- [ ] Clean-clone check of every README command
- [ ] Stretch, only after asking
- [ ] Submission, only with explicit approval
