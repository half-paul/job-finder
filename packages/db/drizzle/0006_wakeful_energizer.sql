CREATE TABLE "company_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"watchlist_id" uuid,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"origin" text DEFAULT 'seed' NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"careers_url" text,
	"ats" text,
	"ats_key" text,
	"strategy" text DEFAULT 'none' NOT NULL,
	"source_id" uuid,
	"policy_check" jsonb,
	"error" text DEFAULT '' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" text DEFAULT 'http-json' NOT NULL,
	"url_template" text NOT NULL,
	"method" text DEFAULT 'GET' NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text,
	"jobs_path" text NOT NULL,
	"field_map" jsonb NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_candidates" ADD CONSTRAINT "company_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_candidates" ADD CONSTRAINT "company_candidates_watchlist_id_company_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."company_watchlists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_candidates" ADD CONSTRAINT "company_candidates_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_patterns" ADD CONSTRAINT "crawl_patterns_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_owner_domain_unique" ON "company_candidates" USING btree ("user_id","domain");--> statement-breakpoint
CREATE INDEX "candidate_status_next_idx" ON "company_candidates" USING btree ("status","next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_pattern_source_unique" ON "crawl_patterns" USING btree ("source_id");