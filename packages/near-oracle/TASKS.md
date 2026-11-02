# Task list

Last updated 2026-11-02.

## Stage 1: Day-1 spike (blocking)

- [x] Verify NEAR facts, recorded in `NOTES.md`
- [x] Create a testnet account, key in gitignored `.env`
- [x] Derive the Ed25519 Solana address: `BuCiH1QgdMdmr4PAgWSQwwtfZhXSYnyRStNGZAzxixuN`
- [x] MPC-sign memo messages, signature verified locally, latency measured
- [x] Land memo transactions on devnet, confirmed with `getTransaction`
- [x] Report explorer links

## Waiting on the owner

- [ ] Decide: this branch or a separate repo
- [ ] Decide: Pyth Hermes key or another trigger
- [ ] Decide: `upsert_attestation` in the allowlist
- [ ] Decide: when `update_config` runs, since covantic.org stops working as oracle
- [ ] Create the `pre-hackathon` tag on `fc4e4ad`
- [ ] Approve the MIT LICENSE at the repo root
- [ ] Decide whether `SPEC.md` and `HACKATHON.md` are committed to the public repo

## Next stages (not started)

- [ ] Scaffold `packages/near-oracle`
- [ ] NEAR contract with guardrails, typed errors and tests
- [ ] Agent: watcher, adjudicator wrapper, tx builder, signing, broadcast, evidence
- [ ] Scripts: derive-address, demo:payout, demo:false-positive, demo:attack
- [ ] Shade Agent TEE deployment on Phala, local mode kept runnable
- [ ] Docs: README, ARCHITECTURE, root README section
- [ ] Clean-clone check of every README command
- [ ] Stretch, only after asking
- [ ] Submission, only with explicit approval
