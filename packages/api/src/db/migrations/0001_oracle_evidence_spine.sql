CREATE TABLE IF NOT EXISTS "claim_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"bundle" jsonb NOT NULL,
	"bundle_hash" varchar(64) NOT NULL,
	"verdict" jsonb NOT NULL,
	"verdict_hash" varchar(64) NOT NULL,
	"adjudicator_version" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "review_reason" varchar(128);--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "verify_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_evidence_claim" ON "claim_evidence" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_evidence_bundle_hash" ON "claim_evidence" USING btree ("bundle_hash");