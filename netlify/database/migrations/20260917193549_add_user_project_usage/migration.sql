CREATE TABLE "user_project_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"anon_id" text,
	"user_id" uuid,
	"project_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "user_project_usage_anon_id_idx" ON "user_project_usage" ("anon_id");--> statement-breakpoint
CREATE INDEX "user_project_usage_user_id_idx" ON "user_project_usage" ("user_id");--> statement-breakpoint
ALTER TABLE "user_project_usage" ADD CONSTRAINT "user_project_usage_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;