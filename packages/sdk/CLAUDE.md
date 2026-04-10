# SDK Plugin — Covantic

Solana Agent Kit integration for AI agents.

## Structure

```
src/
  plugin.ts   — CovanticPlugin class with 5 actions + getTools()
  index.ts    — Re-export
```

## Actions

1. `getRiskScore(agentAddress)` — Fetch risk assessment from API
2. `buyInsurance(agentAddress, coverageAmount, durationDays)` — Purchase policy on-chain
3. `getActivePolicy(agentAddress)` — Query current policy
4. `submitClaim(policyId, triggerType, txSignature)` — File insurance claim
5. `cancelPolicy(policyId)` — Cancel and get pro-rata refund

`getTools()` returns LangChain-compatible tool definitions for agent frameworks.

## Dependencies

- `@covantic/shared` for types
- `@coral-xyz/anchor` + `@solana/web3.js` for on-chain interaction
