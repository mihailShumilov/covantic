CREATE TABLE IF NOT EXISTS "agent_outflow_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_address" varchar(44) NOT NULL,
	"tx_signature" varchar(128) NOT NULL,
	"mint" varchar(44) NOT NULL,
	"amount_raw" bigint NOT NULL,
	"decimals" integer NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outflow_agent_time" ON "agent_outflow_events" USING btree ("agent_address","block_time");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outflow_agent_mint_time" ON "agent_outflow_events" USING btree ("agent_address","mint","block_time");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outflow_event_unique" ON "agent_outflow_events" USING btree ("agent_address","tx_signature","mint");
