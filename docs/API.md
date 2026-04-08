# API Documentation

Base URL: `http://localhost:4000`

## Endpoints

### Health

| Method | Route       | Description                              |
| ------ | ----------- | ---------------------------------------- |
| GET    | /api/health | Health check with DB/Redis/Solana status |

### Risk Assessment

| Method | Route                           | Description                  |
| ------ | ------------------------------- | ---------------------------- |
| GET    | /api/risk/:agentAddress         | Get risk score for an agent  |
| POST   | /api/risk/:agentAddress/refresh | Force recalculate risk score |

### Policies

| Method | Route                   | Description                                 |
| ------ | ----------------------- | ------------------------------------------- |
| GET    | /api/policies           | List policies (query: holder, state, agent) |
| GET    | /api/policies/:policyId | Get policy details                          |
| POST   | /api/policies/quote     | Get premium quote                           |

### Claims

| Method | Route           | Description                         |
| ------ | --------------- | ----------------------------------- |
| GET    | /api/claims     | List claims (query: status, holder) |
| GET    | /api/claims/:id | Get claim details                   |

### Vault

| Method | Route              | Description              |
| ------ | ------------------ | ------------------------ |
| GET    | /api/vault/stats   | Current vault statistics |
| GET    | /api/vault/history | Vault snapshot history   |

### Staking

| Method | Route                 | Description         |
| ------ | --------------------- | ------------------- |
| GET    | /api/staking/:address | Get staker position |

### Monitoring

| Method | Route                      | Description               |
| ------ | -------------------------- | ------------------------- |
| GET    | /api/monitoring/events     | Recent monitoring events  |
| POST   | /api/monitoring/webhook    | Helius webhook endpoint   |
| POST   | /api/demo/simulate-exploit | Simulate exploit for demo |

### Protocol

| Method | Route                  | Description             |
| ------ | ---------------------- | ----------------------- |
| GET    | /api/protocol/overview | Public protocol metrics |

## WebSocket

Connect to `ws://localhost:4000/ws`

### Subscribe to channel

```json
{ "action": "subscribe", "channel": "claims:feed" }
```

### Channels

- `claims:feed` — new claims in real-time
- `vault:stats` — vault state updates
- `monitoring:alerts` — critical alerts
