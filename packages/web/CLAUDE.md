# Frontend — Covantic

## Structure

```
src/
  app/
    page.tsx              — Landing (hero, how-it-works, live stats)
    layout.tsx            — Root layout with providers
    dashboard/page.tsx    — Risk assessment, on-chain policies list + enrichment sidecar, buy-policy modal
    assessment/[id]/page.tsx — Shareable risk assessment detail
    staking/page.tsx      — Pool stats, stake form, position, request/execute unstake, claim rewards
    claims/page.tsx       — Live claims list (WebSocket), verification pipeline sidebar
    protocol/page.tsx     — Protocol stats, premium distribution chart
    demo/page.tsx         — 4 exploit simulations, event log, auto-play pipeline
    fleet/page.tsx        — Fleet agents + scrolling activity feed (polls /api/fleet every 6s).
                            Distinguishes runner-side `error` (red) from on-chain `meta.err`
                            via `describeOnChainErr` (muted, expected outcome for `fail` rows).
  components/
    ui/                   — Button, Card, Badge, Spinner, Modal
    layout/Header.tsx     — Nav (Dashboard / Fleet / Protocol / Staking / Claims / Demo) + WalletButton
    claims/ClaimVerificationPipeline.tsx — 5-step pipeline bound to WebSocket state
    risk/                 — Risk assessment pipeline animation
    policy/, staking/, wallet/, charts/
  providers/
    WalletProvider.tsx    — Solana wallet adapter (Phantom, Solflare) — devnet
    CovanticProvider.tsx  — Context: vaultStats via vault:stats WebSocket stream
  lib/
    api-client.ts         — apiGet / apiPost + ApiError (carries machine-readable `code`)
    explorer.ts           — Solana Explorer URL builders + signature validation
    risk-labels.ts, ...
  idl/
    covantic.ts           — Anchor IDL regen (includes upsertAttestation + riskAttestation)
  styles/
    globals.css           — Dark theme, oklch colors, animations
```

## Key Patterns

- Next.js 16 App Router with `"use client"` for interactive components
- Tailwind CSS with CSS custom properties for theming
- Solana Wallet Adapter for wallet connection
- API calls to `http://localhost:4099/api/` (configurable via `NEXT_PUBLIC_API_URL`)
- `@covantic/shared` for all types and constants
- Dashboard reads policies directly from chain via `program.account.insurancePolicy.all()`
  with a `memcmp` filter on the holder address. The `/api/policies/enrichment` call layers
  agent identity + claim status + indexer meta on top.
- **Defensive rendering**: the PolicyCard treats `state=Active && expiry_time < now` as
  `Expired (pending)` — a safety net against a lagging on-chain expiry-crank.

## Buy Policy Flow

1. User runs risk assessment → persisted server-side.
2. `POST /api/policies/quote` with `{coverageAmount, durationSeconds, agentAddress}` (no tier).
   The server derives the tier from the latest assessment, publishes/refreshes the
   oracle-signed `RiskAttestation` PDA, and returns the full `PremiumQuote` including
   `attestationPda` + `attestationExpiresAt`. UI branches on error `code` values
   (`ASSESSMENT_REQUIRED` / `AGENT_UNINSURABLE` / `ASSESSMENT_STALE` / `ATTESTATION_PUBLISH_FAILED`).
3. User signs `createPolicy` including the `attestation` account — the on-chain program
   rejects the tx if the attestation is missing, for a different agent, or expired.

## Commands

```bash
pnpm --filter web dev     # Dev server on port 3099
pnpm --filter web build   # Production build
```

## Port: 3099
