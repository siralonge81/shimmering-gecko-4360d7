CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"ref_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid,
	"slug" text,
	"title" text NOT NULL,
	"logline" text DEFAULT '' NOT NULL,
	"synopsis" text DEFAULT '' NOT NULL,
	"genres" jsonb DEFAULT '[]' NOT NULL,
	"brief" text DEFAULT '' NOT NULL,
	"mode" text DEFAULT 'basic' NOT NULL,
	"duration_seconds" integer DEFAULT 60 NOT NULL,
	"scene_heading" text DEFAULT '' NOT NULL,
	"poster_key" text,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "render_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"shot_number" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider" text,
	"provider_job_id" text,
	"clip_key" text,
	"error" text,
	"credits_held" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"heading" text NOT NULL,
	"action" text DEFAULT '' NOT NULL,
	"dialogue" jsonb DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"shot_type" text DEFAULT 'Medium shot' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"image_prompt" text DEFAULT '' NOT NULL,
	"camera" text DEFAULT 'Static' NOT NULL,
	"lighting" text DEFAULT 'Available light' NOT NULL,
	"mood" text DEFAULT 'Neutral' NOT NULL,
	"duration_seconds" integer DEFAULT 5 NOT NULL,
	"frame_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"identity_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "credit_ledger_user_id_idx" ON "credit_ledger" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_key" ON "projects" ("slug");--> statement-breakpoint
CREATE INDEX "projects_user_id_idx" ON "projects" ("user_id");--> statement-breakpoint
CREATE INDEX "projects_published_idx" ON "projects" ("published");--> statement-breakpoint
CREATE INDEX "render_jobs_project_id_idx" ON "render_jobs" ("project_id");--> statement-breakpoint
CREATE INDEX "render_jobs_status_idx" ON "render_jobs" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "render_jobs_open_shot_key" ON "render_jobs" ("project_id","shot_number") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "scenes_project_position_key" ON "scenes" ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "shots_project_number_key" ON "shots" ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "users_identity_id_key" ON "users" ("identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "votes_project_user_key" ON "votes" ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "votes_project_id_idx" ON "votes" ("project_id");--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;