# Shared Package — AgentGuard

Cross-package types, constants, and utilities. Imported as `@agentguard/shared`.

## Structure

```
src/
  types/
    policy.ts   — PolicyState(0-5), RiskTier(0-3), TriggerType(0-4), Policy, PremiumQuote
    vault.ts    — SolvencyStatus, VaultStats, VaultSnapshot
    risk.ts     — RiskFactors (7 fields), RiskAssessment, Agent
    claims.ts   — ClaimStatus, VerificationStep, StepStatus, Claim, PipelineStep
    events.ts   — WSMessage, WSChannel, MonitoringEventType, MonitoringSeverity
  constants.ts  — All protocol constants (decimals, limits, BPS, thresholds, seeds)
  utils.ts      — calculatePremium(), scoreToTier(), solvencyStatus(), formatUsdc()
  index.ts      — Re-exports everything
```

## Rule

This package is the single source of truth for types and constants.
Never duplicate these definitions in other packages — always import from `@agentguard/shared`.

Must be built before other packages: `pnpm --filter shared build`.
