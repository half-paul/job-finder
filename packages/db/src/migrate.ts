import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, getPool } from "./index";
try {
  await getPool().query("CREATE EXTENSION IF NOT EXISTS vector");
  await migrate(getDb(), { migrationsFolder: "packages/db/drizzle" });
} finally {
  await getPool().end();
}
console.log("Database migrations applied.");
