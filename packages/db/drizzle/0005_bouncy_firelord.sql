CREATE TABLE "automation_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_watchlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company" text NOT NULL,
	"company_key" text NOT NULL,
	"domain" text DEFAULT '' NOT NULL,
	"provider" text,
	"board" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT 'Interesting' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"score" integer,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_sources" ADD COLUMN "schedule" text DEFAULT 'Manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_sources" ADD COLUMN "next_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_sources" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "search_runs" ADD COLUMN "trigger" text DEFAULT 'Manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_runs" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "company_watchlists" ADD CONSTRAINT "company_watchlists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_watchlists" ADD CONSTRAINT "company_watchlists_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_owner_company_unique" ON "company_watchlists" USING btree ("user_id","company_key");--> statement-breakpoint
CREATE INDEX "watchlist_owner_idx" ON "company_watchlists" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_owner_dedupe_unique" ON "notifications" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_owner_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "sources_due_idx" ON "job_sources" USING btree ("enabled","next_run_at");