CREATE TABLE "job_embeddings" (
	"job_id" uuid NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_embeddings_job_id_model_pk" PRIMARY KEY("job_id","model")
);
--> statement-breakpoint
CREATE TABLE "target_embeddings" (
	"user_id" uuid NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_embeddings_user_id_model_pk" PRIMARY KEY("user_id","model")
);
--> statement-breakpoint
ALTER TABLE "job_matches" ADD COLUMN "input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_matches" ADD COLUMN "output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_matches" ADD COLUMN "embedding_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_matches" ADD COLUMN "estimated_cost_micros" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_embeddings" ADD CONSTRAINT "job_embeddings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_embeddings" ADD CONSTRAINT "target_embeddings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;