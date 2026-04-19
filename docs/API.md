# API Documentation

Base URL: `http://localhost:4099`

All routes are mounted under `/api/`. Request/response bodies are JSON. Input is validated with
Zod; 4xx responses carry a `{ error, code?, ... }` shape.

## Endpoints

### Health

| Method | Route       | Description                              |
| ------ | ----------- | ---------------------------------------- |
| GET    | /api/health | DB + Redis status and server timestamp   |

### Risk Assessment

| Method | Route                           | Description                                               |
| ------ | ------------------------------- | --------------------------------------------------------- |
| GET    | /api/risk/:agentAddress         | Current risk score + 7 factor breakdown (Redis-cached 5m) |
| POST   | /api/risk/:agentAddress/refresh | Bypass cache and recompute                                |
| GET    | /api/assessments                | List recent assessments                                   |
| GET    | /api/assessments/:id            | Single assessment detail (shareable report page source)   |

### Policies

| Method | Route                              | Description                                                                                                              |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET    | /api/policies                      | List policies (query: `holder`, `state`, `agent`)                                                                        |
| GET    | /api/policies/:policyId            | Get policy DB row                                                                                                        |
| POST   | /api/policies/quote                | Get premium quote + publish oracle-signed `RiskAttestation` (see **Quote** below)                                        |
| GET    | /api/policies/enrichment           | Batch sidecar for the dashboard: agent identity + most-recent claim + indexer meta, keyed by policyId and agent address  |
| GET    | /api/policies/:policyId/why-active | Diagnostic — side-by-side DB vs on-chain view with `diagnosis[]` and typed `onChainReason`                               |

#### Quote

`POST /api/policies/quote`

Body (Zod):

```json
{
  "coverageAmount": 50000000,   // USDC lamports (6 decimals)
  "durationSeconds": 43200,
  "agentAddress": "ADaUMi..."
}
```

**`riskTier` is not accepted** — it is derived from the agent's latest on-record risk assessment.

Success `200`:

```json
{
  "agentAddress": "ADaUMi...",
  "coverageAmount": 50000000,
  "durationSeconds": 43200,
  "riskTier": 1,
  "premiumAmount": 1426,
  "premiumBps": 250,
  "assessmentId": "uuid",
  "assessedAt": "2026-04-19T14:00:00.000Z",
  "validUntil": "2026-04-19T14:10:00.000Z",
  "attestationPda": "F1bap...",
  "attestationExpiresAt": "2026-04-19T15:00:00.000Z"
}
```

Error `400` / `503`:

| `code` | Meaning |
| --- | --- |
| `ASSESSMENT_REQUIRED` | No risk assessment on record for this agent |
| `AGENT_UNINSURABLE` | Assessed tier is EXTREME |
| `ASSESSMENT_STALE` | Assessment is > 600 s old |
| `ATTESTATION_PUBLISH_FAILED` | Oracle couldn't write the attestation PDA (RPC issue) |

#### Enrichment

`GET /api/policies/enrichment?agents=a,b,c&policyIds=0,1,2`

Returns three keyed records for O(1) lookup on the client:

```json
{
  "agents":  { "<agentAddress>":  { name, description, currentRiskTier, currentRiskScore, riskScoredAt } },
  "claims":  { "<policyId>":      { id, status, triggerType, triggerTxSignature, payoutAmount, ... } },
  "meta":    { "<policyId>":      { createTxSignature, pdaAddress, updatedAt, indexerLagSec } }
}
```

Unknown addresses / policyIds are omitted — the client treats missing keys as "no context yet".

#### why-active

`GET /api/policies/:policyId/why-active` — diagnostic. Returns the DB row and the on-chain PDA
side-by-side with a `diagnosis[]` array naming every inconsistency:

```json
{
  "policyId": 0,
  "now": "2026-04-19T14:38:00Z",
  "db": { "state": 3, "stateName": "Expired", "pdaAddress": "...", ... },
  "onChain": { "state": 3, "stateName": "Expired", ... } | null,
  "onChainError": null | "...",
  "onChainReason": null | "not-found" | "owner-mismatch" | "decode-error" | "rpc-error",
  "readerAvailable": true,
  "active": { "dbSaysActive": false, "chainSaysActive": false, "withinCoverageWindow": false },
  "indexerLagSec": 1,
  "diagnosis": []
}
```

### Claims

| Method | Route           | Description                           |
| ------ | --------------- | ------------------------------------- |
| GET    | /api/claims     | List claims (query: `status`, `holder`) |
| GET    | /api/claims/:id | Claim detail                          |

### Vault

| Method | Route              | Description                    |
| ------ | ------------------ | ------------------------------ |
| GET    | /api/vault/stats   | Live vault + solvency metrics  |
| GET    | /api/vault/history | Vault snapshot history         |

### Staking

| Method | Route                 | Description                       |
| ------ | --------------------- | --------------------------------- |
| GET    | /api/staking/:address | Staker position with live rewards |

### Protocol

| Method | Route                  | Description                                            |
| ------ | ---------------------- | ------------------------------------------------------ |
| GET    | /api/protocol/overview | Public metrics: TVP, active policies, premiums, claims |

### Fleet

| Method | Route      | Description                                                                        |
| ------ | ---------- | ---------------------------------------------------------------------------------- |
| GET    | /api/fleet | Manifest of bootstrapped fleet agents + last ≤ 100 activity entries from Redis     |

The manifest is loaded from `keys/fleet.json` (populated by `pnpm fleet:bootstrap`). Activity
is pushed into the Redis list `covantic:fleet:activity` (capped at 500) by `pnpm fleet:start`.

Activity entry shape (`FleetActivityEntry`, in `@covantic/shared`-shaped JSON):

```json
{
  "timestamp": 1776440442000,
  "agentName": "fleet-abc-0",
  "agentPubkey": "…",
  "kind": "safe" | "large" | "fail" | "skip" | "error",
  "amountUi": 42.5,
  "signature": "4aHC2…",
  "error": null | "…",           // runner / RPC exception (no tx landed)
  "onChainErr": null | { … },    // structured meta.err from a confirmed-failed tx
  "failureKind": "failed_tx" | …  // which FailureStrategy produced this row
}
```

`kind: "fail"` rows normally carry `signature` + `onChainErr` (expected
on-chain failure). An `error` field on a `fail` row means the runner itself
threw and no tx reached the cluster — treat as alert-worthy in production.

### Monitoring

| Method | Route                       | Description                                                               |
| ------ | --------------------------- | ------------------------------------------------------------------------- |
| GET    | /api/monitoring/events      | Recent DB-persisted monitoring events                                     |
| POST   | /api/monitoring/webhook     | Helius webhook ingress (HMAC-of-body OR `Authorization: Bearer <secret>`) |
| GET    | /api/monitoring/metrics     | Cumulative counters + `policyLag` block for dashboards / alerting         |
| POST   | /api/demo/simulate-exploit  | Synthetic trigger for demo (gated by `NODE_ENV !== production`)           |

#### Webhook auth

The webhook endpoint accepts either:

- HMAC-SHA256 of the raw body on `x-helius-hmac-signature` — used by internal callers and tests.
- Static bearer token `Authorization: Bearer <HELIUS_WEBHOOK_SECRET>` — used by real Helius
  deliveries (Helius does not currently HMAC-sign payloads).

Rotate via `pnpm webhook:sync` which is idempotent.

#### Monitoring metrics

```json
{
  "monitor": {
    "skipped:no_addresses": 0,
    "skipped:uninsured": 0,
    "skipped:inactive_policy": 0,
    "matched:active": 0,
    "anomaly:warning": 0,
    "anomaly:critical": 0,
    "error:tx": 0
  },
  "policyLag": {
    "stuckCount": 0,
    "maxLagSec": 0,
    "oldestExpiry": null
  },
  "now": "2026-04-19T14:38:00Z"
}
```

A non-zero `stuckCount` means the expiry-crank or policy-indexer is falling behind.

## WebSocket

Connect to `ws://localhost:4099/ws`.

### Subscribe

```json
{ "action": "subscribe", "channel": "claims:feed" }
```

### Channels

- `claims:feed` — new claims and status transitions in real-time
- `vault:stats` — vault state updates (staked, coverage, solvency tier)
- `monitoring:alerts` — critical alerts (signed on the internal bus before broadcast)
