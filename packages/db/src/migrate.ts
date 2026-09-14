import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, getPool } from "./index";
await migrate(getDb(), { migrationsFolder: "packages/db/drizzle" });
await getPool().query("CREATE EXTENSION IF NOT EXISTS vector");
await getPool().end();
console.log("Database migrations applied.");
