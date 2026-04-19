CREATE TABLE IF NOT EXISTS "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" varchar(44) NOT NULL,
	"owner_address" varchar(44) NOT NULL,
	"name" varchar(128),
	"description" text,
	"risk_score" real,
	"risk_tier" smallint,
	"risk_scored_at" timestamp with time zone,
	"risk_data" jsonb,
	"total_transactions" integer DEFAULT 0,
	"failed_transactions" integer DEFAULT 0,
	"protocols_used" integer DEFAULT 0,
	"wallet_age_days" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" bigint NOT NULL,
	"holder_address" varchar(44) NOT NULL,
	"agent_address" varchar(44) NOT NULL,
	"trigger_type" smallint NOT NULL,
	"trigger_tx_signature" varchar(128) NOT NULL,
	"loss_amount" bigint,
	"payout_amount" bigint,
	"verification_data" jsonb,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"submit_tx_signature" varchar(128),
	"payout_tx_signature" varchar(128),
	"lock_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monitoring_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_address" varchar(44) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"severity" varchar(16) NOT NULL,
	"tx_signature" varchar(128),
	"details" jsonb,
	"processed" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" bigint NOT NULL,
	"holder_address" varchar(44) NOT NULL,
	"agent_address" varchar(44) NOT NULL,
	"coverage_amount" bigint NOT NULL,
	"premium_paid" bigint NOT NULL,
	"risk_tier" smallint NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"expiry_time" timestamp with time zone NOT NULL,
	"claim_submitted_at" timestamp with time zone,
	"state" smallint DEFAULT 0 NOT NULL,
	"trigger_type" smallint DEFAULT 0,
	"trigger_tx_signature" varchar(128),
	"payout_amount" bigint DEFAULT 0,
	"pda_address" varchar(44) NOT NULL,
	"create_tx_signature" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_policy_id_unique" UNIQUE("policy_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_address" varchar(44) NOT NULL,
	"risk_score" real NOT NULL,
	"risk_tier" smallint NOT NULL,
	"premium_bps" integer,
	"factors" jsonb NOT NULL,
	"factor_details" jsonb NOT NULL,
	"category_risks" jsonb NOT NULL,
	"weight_info" jsonb NOT NULL,
	"data_availability" jsonb NOT NULL,
	"overall_confidence" real NOT NULL,
	"summary" text NOT NULL,
	"recommendation" text NOT NULL,
	"assessed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vault_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"total_staked" bigint NOT NULL,
	"total_coverage" bigint NOT NULL,
	"total_premiums" bigint NOT NULL,
	"total_claims_paid" bigint NOT NULL,
	"staker_count" integer NOT NULL,
	"solvency_ratio" real NOT NULL,
	"active_policies" integer NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agents_wallet" ON "agents" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agents_owner" ON "agents" USING btree ("owner_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agents_risk_tier" ON "agents" USING btree ("risk_tier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claims_policy" ON "claims" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claims_status" ON "claims" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claims_holder" ON "claims" USING btree ("holder_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_monitoring_agent" ON "monitoring_events" USING btree ("agent_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_monitoring_type" ON "monitoring_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_monitoring_processed" ON "monitoring_events" USING btree ("processed");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_policies_holder" ON "policies" USING btree ("holder_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_policies_agent" ON "policies" USING btree ("agent_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_policies_state" ON "policies" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_policies_expiry" ON "policies" USING btree ("expiry_time");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_risk_assessments_agent" ON "risk_assessments" USING btree ("agent_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_risk_assessments_created" ON "risk_assessments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_snapshots_time" ON "vault_snapshots" USING btree ("snapshot_at");