CREATE TABLE "search_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'Running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"discovered" integer DEFAULT 0 NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
DROP INDEX "source_board_unique";--> statement-breakpoint
ALTER TABLE "job_references" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "job_references" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "job_sources" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "job_sources" ADD COLUMN "identity" text;--> statement-breakpoint
ALTER TABLE "job_sources" ADD COLUMN "region" text DEFAULT 'global' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_sources" ADD COLUMN "etag" text;--> statement-breakpoint
ALTER TABLE "job_sources" ADD COLUMN "last_modified" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "salary_period" text DEFAULT 'year' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_runs" ADD CONSTRAINT "search_runs_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_runs" ADD CONSTRAINT "search_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_runs_owner_started_idx" ON "search_runs" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "job_sources" ADD CONSTRAINT "job_sources_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_owner_identity_unique" ON "job_sources" USING btree ("owner_id","identity");