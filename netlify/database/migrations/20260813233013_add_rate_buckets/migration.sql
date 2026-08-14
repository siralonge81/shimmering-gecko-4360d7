CREATE TABLE "rate_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"identity_id" text,
	"ip" text,
	"action" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rate_buckets_key_window_key" ON "rate_buckets" ("identity_id","ip","action","window_start");--> statement-breakpoint
CREATE INDEX "rate_buckets_window_idx" ON "rate_buckets" ("window_start");