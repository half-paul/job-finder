ALTER TABLE "jobs" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "search_runs" ADD COLUMN "filtered" integer DEFAULT 0 NOT NULL;