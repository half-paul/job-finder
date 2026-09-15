import "server-only";
import { getDb } from "@jobfinder/db";
import {
  createSource as createSourceRecord,
  listSources as listSourcesRecord,
  scanSourceRecord,
} from "@jobfinder/automation";

/**
 * Web-facing wrappers around the shared automation services. The scan engine
 * itself lives in `@jobfinder/automation` so the worker runs exactly the same
 * code for scheduled scans.
 */
export async function listSources(userId: string) {
  return listSourcesRecord(getDb(), userId);
}

export async function createSource(userId: string, body: unknown) {
  return createSourceRecord(getDb(), userId, body);
}

/** Interactive scans are user-triggered and bounded; schedules run in the worker. */
export async function scanSource(userId: string, sourceId: string) {
  return scanSourceRecord({ userId, sourceId, trigger: "Manual" });
}
