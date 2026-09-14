import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
export * from "./schema";
const globalDb = globalThis as typeof globalThis & { jobfinderPool?: Pool };
export function getPool() {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required. See README.md.");
  return (globalDb.jobfinderPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  }));
}
export function getDb() {
  return drizzle({ client: getPool(), schema });
}
