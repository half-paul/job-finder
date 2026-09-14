ALTER TABLE "job_sources" ADD COLUMN "company" text NOT NULL DEFAULT '';
ALTER TABLE "job_sources" ALTER COLUMN "company" DROP DEFAULT;
