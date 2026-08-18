import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  real,
  smallint,
  index,
  varchar,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Agents — registered AI agents
export const agents = pgTable(
  'agents',
  {
    id: uuid('id')
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    walletAddress: varchar('wallet_address', { length: 44 }).notNull().unique(),
    ownerAddress: varchar('owner_address', { length: 44 }).notNull(),
    name: varchar('name', { length: 128 }),
    description: text('description'),

    // Risk scoring
    riskScore: real('risk_score'),
    riskTier: smallint('risk_tier'),
    riskScoredAt: timestamp('risk_scored_at', { withTimezone: true }),
    riskData: jsonb('risk_data'),

    // Cached stats
    totalTransactions: integer('total_transactions').default(0),
    failedTransactions: integer('failed_transactions').default(0),
    protocolsUsed: integer('protocols_used').default(0),
    walletAge: integer('wallet_age_days').default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_agents_wallet').on(table.walletAddress),
    index('idx_agents_owner').on(table.ownerAddress),
    index('idx_agents_risk_tier').on(table.riskTier),
  ],
);

// Risk Assessments — every assessment stored as a separate record for history & sharing
export const riskAssessments = pgTable(
  'risk_assessments',
  {
    id: uuid('id')
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    agentAddress: varchar('agent_address', { length: 44 }).notNull(),
    riskScore: real('risk_score').notNull(),
    riskTier: smallint('risk_tier').notNull(),
    // Null when tier is EXTREME (uninsurable). Historical rows may contain -1;
    // consumers should treat any non-positive value as "no quote".
    premiumBps: integer('premium_bps'),
    factors: jsonb('factors').notNull(),
    factorDetails: jsonb('factor_details').notNull(),
    categoryRisks: jsonb('category_risks').notNull(),
    weightInfo: jsonb('weight_info').notNull(),
    dataAvailability: jsonb('data_availability').notNull(),
    overallConfidence: real('overall_confidence').notNull(),
    summary: text('summary').notNull(),
    recommendation: text('recommendation').notNull(),
    assessedAt: timestamp('assessed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_risk_assessments_agent').on(table.agentAddress),
    index('idx_risk_assessments_created').on(table.createdAt),
  ],
);

// Policies — mirror of on-chain data + metadata
export const policies = pgTable(
  'policies',
  {
    id: uuid('id')
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    policyId: bigint('policy_id', { mode: 'number' }).notNull().unique(),
    holderAddress: varchar('holder_address', { length: 44 }).notNull(),
    agentAddress: varchar('agent_address', { length: 44 }).notNull(),

    coverageAmount: bigint('coverage_amount', { mode: 'number' }).notNull(),
    premiumPaid: bigint('premium_paid', { mode: 'number' }).notNull(),
    riskTier: smallint('risk_tier').notNull(),

    startTime: timestamp('start_time', { withTimezone: true }).notNull(),
    expiryTime: timestamp('expiry_time', { withTimezone: true }).notNull(),
    claimSubmittedAt: timestamp('claim_submitted_at', { withTimezone: true }),

    state: smallint('state').notNull().default(0),
    triggerType: smallint('trigger_type').default(0),
    triggerTxSignature: varchar('trigger_tx_signature', { length: 128 }),
    payoutAmount: bigint('payout_amount', { mode: 'number' }).default(0),

    pdaAddress: varchar('pda_address', { length: 44 }).notNull(),
    createTxSignature: varchar('create_tx_signature', { length: 128 }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_policies_holder').on(table.holderAddress),
    index('idx_policies_agent').on(table.agentAddress),
    index('idx_policies_state').on(table.state),
    index('idx_policies_expiry').on(table.expiryTime),
  ],
);

// Claims — extended claim information
export const claims = pgTable(
  'claims',
  {
    id: uuid('id')
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    policyId: bigint('policy_id', { mode: 'number' }).notNull(),
    holderAddress: varchar('holder_address', { length: 44 }).notNull(),
    agentAddress: varchar('agent_address', { length: 44 }).notNull(),

    triggerType: smallint('trigger_type').notNull(),
    triggerTxSignature: varchar('trigger_tx_signature', { length: 128 }).notNull(),

    lossAmount: bigint('loss_amount', { mode: 'number' }),
    payoutAmount: bigint('payout_amount', { mode: 'number' }),
    verificationData: jsonb('verification_data'),

    status: varchar('status', { length: 32 }).notNull().default('pending'),
    /** Why the claim sits in `indeterminate` or `review` — the verifier's
     *  reason code, surfaced to the adjuster queue. */
    reviewReason: varchar('review_reason', { length: 128 }),
    /** Verification attempts so far. Indeterminate verdicts retry with
     *  backoff; past the cap the claim escalates to review instead of
     *  looping forever. */
    verifyAttempts: integer('verify_attempts').default(0).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    submitTxSignature: varchar('submit_tx_signature', { length: 128 }),
    payoutTxSignature: varchar('payout_tx_signature', { length: 128 }),

    lockExpiresAt: timestamp('lock_expires_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_claims_policy').on(table.policyId),
    index('idx_claims_status').on(table.status),
    index('idx_claims_holder').on(table.holderAddress),
  ],
);

// Claim Evidence — the immutable inputs a verdict was derived from.
//
// A payout that cannot be re-derived is a payout nobody can audit. Every
// verification attempt writes the full bundle it consulted plus the hash of
// its canonical form, so `pnpm claim:replay <claimId>` can recompute the
// verdict later and any divergence is visible. `bundle_hash` is the value
// committed on-chain once trust-minimised settlement lands.
export const claimEvidence = pgTable(
  'claim_evidence',
  {
    id: uuid('id')
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    claimId: uuid('claim_id').notNull(),
    /** Attempt number this bundle belongs to — indeterminate retries each
     *  leave their own row so the trail shows what changed between them. */
    attempt: integer('attempt').default(1).notNull(),
    bundle: jsonb('bundle').notNull(),
    bundleHash: varchar('bundle_hash', { length: 64 }).notNull(),
    verdict: jsonb('verdict').notNull(),
    verdictHash: varchar('verdict_hash', { length: 64 }).notNull(),
    /** Version of the code that produced the verdict. A replay under a
     *  different version is expected to differ; under the same version it
     *  must not. */
    adjudicatorVersion: varchar('adjudicator_version', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_claim_evidence_claim').on(table.claimId),
    index('idx_claim_evidence_bundle_hash').on(table.bundleHash),
  ],
);

// Monitoring Events — transaction monitoring events
export const monitoringEvents = pgTable(
  'monitoring_events',
  {
    id: uuid('id')
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    agentAddress: varchar('agent_address', { length: 44 }).notNull(),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    severity: varchar('severity', { length: 16 }).notNull(),
    txSignature: varchar('tx_signature', { length: 128 }),
    details: jsonb('details'),
    processed: boolean('processed').default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_monitoring_agent').on(table.agentAddress),
    index('idx_monitoring_type').on(table.eventType),
    index('idx_monitoring_processed').on(table.processed),
  ],
);

// Vault Snapshots — periodic state snapshots
export const vaultSnapshots = pgTable(
  'vault_snapshots',
  {
    id: uuid('id')
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    totalStaked: bigint('total_staked', { mode: 'number' }).notNull(),
    totalCoverage: bigint('total_coverage', { mode: 'number' }).notNull(),
    totalPremiums: bigint('total_premiums', { mode: 'number' }).notNull(),
    totalClaimsPaid: bigint('total_claims_paid', { mode: 'number' }).notNull(),
    stakerCount: integer('staker_count').notNull(),
    solvencyRatio: real('solvency_ratio').notNull(),
    activePolicies: integer('active_policies').notNull(),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_snapshots_time').on(table.snapshotAt)],
);
