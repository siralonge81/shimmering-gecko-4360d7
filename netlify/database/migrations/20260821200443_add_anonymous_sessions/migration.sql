CREATE TABLE "anonymous_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"generations_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "anonymous_session_id" uuid;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD COLUMN "anonymous_session_id" uuid;--> statement-breakpoint
ALTER TABLE "render_jobs" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_anonymous_session_id_idx" ON "projects" ("anonymous_session_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_anonymous_session_id_anonymous_sessions_id_fkey" FOREIGN KEY ("anonymous_session_id") REFERENCES "anonymous_sessions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_anonymous_session_id_anonymous_sessions_id_fkey" FOREIGN KEY ("anonymous_session_id") REFERENCES "anonymous_sessions"("id") ON DELETE SET NULL;