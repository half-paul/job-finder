// tests/e2e/companies.spec.ts
import { test, expect } from "@playwright/test";
import { Pool } from "pg";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://jobfinder:local-development-only@localhost:54329/jobfinder";
process.env.DATABASE_URL ??= databaseUrl;

test("company candidate and crawl pattern tables exist with their constraints", async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('company_candidates','crawl_patterns') ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "company_candidates",
      "crawl_patterns",
    ]);
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE indexname IN ('candidate_owner_domain_unique','crawl_pattern_source_unique')
       ORDER BY 1`,
    );
    expect(indexes.rows.map((r) => r.indexname)).toEqual([
      "candidate_owner_domain_unique",
      "crawl_pattern_source_unique",
    ]);
  } finally {
    await pool.end();
  }
});
