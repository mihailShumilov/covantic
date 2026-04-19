# Shared Package — Covantic

Cross-package types, constants, and utilities. Imported as `@covantic/shared`.

## Structure

```
src/
  types/
    policy.ts   — PolicyState(0-4), RiskTier(0-3), TriggerType(0-4), Policy, PremiumQuote, QuoteErrorCode
    vault.ts    — SolvencyStatus, VaultStats, VaultSnapshot
    risk.ts     — RiskFactors (7 fields), RiskAssessment, Agent
    claims.ts   — ClaimStatus, VerificationStep, StepStatus, Claim, PipelineStep, VerificationData
    events.ts   — WSMessage, WSChannel, MonitoringEventType, MonitoringSeverity
  constants.ts  — All protocol constants (decimals, limits, BPS, thresholds, seeds,
                   PDA_SEEDS incl. ATTESTATION, ATTESTATION_MAX_VALIDITY_SECONDS,
                   SOLANA_ADDRESS_REGEX, SOLANA_SIGNATURE_REGEX, SPL_MEMO_PROGRAM_ID,
                   MAX_TX_BYTES, SYNTHETIC_PAYOUT_RATIO)
  utils.ts      — calculatePremium(), tierToPremiumBps(), scoreToTier(),
                   solvencyStatus(), formatUsdc(), formatDuration(),
                   shortenAddress(), generateDemoTxSignature(), TIER_LABELS, STATE_LABELS
  index.ts      — Re-exports everything
```

## Key Enums (must stay in sync with Anchor)

- `PolicyState`: Active=0, ClaimPending=1, ClaimPaid=2, Expired=3, Cancelled=4
- `RiskTier`: LOW=0, MEDIUM=1, HIGH=2, EXTREME=3
- `TriggerType`: None=0, Exploit=1, OracleManipulation=2, AgentError=3, GovernanceAttack=4
- `QuoteErrorCode`: `ASSESSMENT_REQUIRED` | `AGENT_UNINSURABLE` | `ASSESSMENT_STALE` | `ATTESTATION_PUBLISH_FAILED`

## Fleet Constants

- `SPL_MEMO_PROGRAM_ID` — canonical Memo v2 program ID (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`).
  Stable across mainnet-beta / devnet / testnet. Used by the fleet runner to produce
  deliberately-failing transactions via a non-UTF-8 memo payload.
- `MAX_TX_BYTES = 1232` — Solana `PACKET_DATA_SIZE`. Fleet failure strategies assert
  serialized txs stay under this limit so nothing is rejected client-side.

## PremiumQuote

The `/api/policies/quote` response shape. Includes `riskTier` (server-derived),
`premiumAmount`, `assessmentId`, `assessedAt`, `validUntil`, `attestationPda`,
`attestationExpiresAt`.

## Rule

This package is the single source of truth for types and constants.
Never duplicate these definitions in other packages — always import from `@covantic/shared`.

Must be built before other packages: `pnpm --filter shared build`.
