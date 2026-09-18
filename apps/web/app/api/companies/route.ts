import { z } from "zod";
import { getDb } from "@jobfinder/db";
import { companyImportSchema } from "@jobfinder/shared";
import {
  importCompanies,
  listCompanies,
  workerHealth,
} from "@jobfinder/automation";
import { requireUser, rateLimit } from "../../../lib/auth";
import { errorResponse, readJson, verifyOrigin } from "../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const singleCompany = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/),
  url: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .regex(/^[^\r\n]+$/),
});
export async function GET() {
  try {
    const user = await requireUser();
    const db = getDb();
    const [companies, worker] = await Promise.all([
      listCompanies(db, user.id),
      workerHealth(db),
    ]);
    return Response.json(
      { companies, worker },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    verifyOrigin(request);
    const user = await requireUser();
    await rateLimit(`companies:${user.id}`, 30, 3600);
    const body = await readJson(request);
    const single = singleCompany.safeParse(body);
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const input = single.success
      ? { text: `${escape(single.data.name)},${escape(single.data.url)}` }
      : companyImportSchema.parse(body);
    const result = await importCompanies(getDb(), user.id, input.text);
    return Response.json(result, { status: result.imported ? 202 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
