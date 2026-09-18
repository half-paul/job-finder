import {
  listActivity,
  retryCompany,
  deleteCompany,
  recordActivity,
} from "@jobfinder/automation";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  getDb,
  profiles,
  preferences,
  resumes,
  auditEvents,
  targetEmbeddings,
} from "@jobfinder/db";
import {
  defaultPreferences,
  profileSchema,
  preferencesSchema,
} from "@jobfinder/shared";
import {
  authenticate,
  logout,
  rateLimit,
  requireUser,
} from "../../../lib/auth";
import {
  HttpError,
  errorResponse,
  readBody,
  readJson,
  verifyOrigin,
} from "../../../lib/http";
import { createSource, listSources, scanSource } from "../../../lib/discovery";
import {
  alertOnMatches,
  evaluateJob,
  evaluateSyncedJobs,
} from "../../../lib/matching";
import { alerts, automation, watchlist } from "../../../lib/automation";
import {
  createJob,
  getJob,
  listJobs,
  setArchived,
  updateStatus,
} from "../../../lib/jobs";
import { extractResume, maxResumeBytes } from "../../../lib/resumes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
async function handle(request: Request, context: Context) {
  let activityUserId: string | null = null;
  try {
    const { path } = await context.params;
    const route = path.join("/");
    const method = request.method;
    if (!["GET", "HEAD"].includes(method)) verifyOrigin(request);
    if (route === "health" && method === "GET") {
      await getDb().execute(sql`select 1`);
      return Response.json({ status: "ok" });
    }
    if (
      method === "POST" &&
      (route === "auth/register" || route === "auth/login")
    )
      return Response.json(
        await authenticate(await readJson(request), route.endsWith("register")),
      );
    if (method === "POST" && route === "auth/logout") {
      await logout();
      return Response.json({ ok: true });
    }
    const user = await requireUser();
    activityUserId = user.id;
    const db = getDb();
    if (route === "activity" && method === "GET") {
      const params = new URL(request.url).searchParams;
      const beforeId = params.get("beforeId");
      const candidateId = params.get("candidateId");
      return Response.json(
        await listActivity(db, user.id, {
          beforeId: beforeId ? z.uuid().parse(beforeId) : undefined,
          candidateId: candidateId ? z.uuid().parse(candidateId) : undefined,
        }),
      );
    }
    if (path[0] === "companies" && path.length === 2) {
      const id = z.uuid().parse(path[1]);
      if (method === "POST") {
        await rateLimit(`company-retry:${user.id}`, 30, 3600);
        return Response.json(await retryCompany(db, user.id, id));
      }
      if (method === "DELETE")
        return Response.json(await deleteCompany(db, user.id, id));
    }
    if (!["GET", "HEAD"].includes(method))
      await recordActivity(db, {
        userId: user.id,
        actor: "Application",
        stage: "request",
        message: `${method} ${path
          .filter((part) => !/^[a-f0-9-]{36}$/.test(part))
          .join("/")
          .slice(0, 100)} requested.`,
      });
    if (route === "jobs/evaluation-batch" && method === "POST") {
      await rateLimit(`ai-batch:${user.id}`, 20, 3600);
      const result = await evaluateSyncedJobs(user.id, await readJson(request));
      const alertsCreated = result.evaluated
        ? await alertOnMatches(user.id)
        : 0;
      return Response.json({ ...result, alertsCreated });
    }
    if (route === "automation" && method === "GET")
      return Response.json(await automation.overview(user.id));
    if (route === "automation/digest" && method === "POST") {
      await rateLimit(`digest:${user.id}`, 10, 3600);
      return Response.json(
        await automation.digest(user.id, await readJson(request)),
      );
    }
    if (route === "notifications" && method === "GET")
      return Response.json(await alerts.list(user.id));
    if (route === "notifications/mark" && method === "POST")
      return Response.json(await alerts.mark(user.id, await readJson(request)));
    if (route === "watchlist") {
      if (method === "GET") return Response.json(await watchlist.list(user.id));
      if (method === "POST") {
        await rateLimit(`watchlist:${user.id}`, 60, 3600);
        return Response.json(
          await watchlist.create(user.id, await readJson(request)),
          { status: 201 },
        );
      }
    }
    if (path[0] === "watchlist" && path.length === 2) {
      const id = z.uuid().parse(path[1]);
      if (method === "PUT")
        return Response.json(
          await watchlist.update(user.id, id, await readJson(request)),
        );
      if (method === "DELETE")
        return Response.json(await watchlist.remove(user.id, id));
    }
    if (route === "sources" && method === "GET")
      return Response.json(await listSources(user.id));
    if (route === "sources" && method === "POST") {
      await rateLimit(`sources:${user.id}`, 20, 3600);
      return Response.json(
        await createSource(user.id, await readJson(request)),
        {
          status: 201,
        },
      );
    }
    if (path[0] === "sources" && path.length === 2) {
      const id = z.uuid().parse(path[1]);
      if (method === "POST" && path.length === 2)
        return Response.json(await scanSource(user.id, id));
    }
    if (
      path[0] === "sources" &&
      path.length === 3 &&
      path[2] === "schedule" &&
      method === "PUT"
    ) {
      const id = z.uuid().parse(path[1]);
      return Response.json(
        await automation.scheduleSource(user.id, id, await readJson(request)),
      );
    }
    if (route === "profile") {
      if (method === "GET") {
        const [row] = await db
          .select()
          .from(profiles)
          .where(eq(profiles.userId, user.id));
        return Response.json(row.data);
      }
      if (method === "PUT") {
        const data = profileSchema.parse(await readJson(request));
        await db.transaction(async (tx) => {
          await tx
            .update(profiles)
            .set({ data, updatedAt: new Date() })
            .where(eq(profiles.userId, user.id));
          await tx
            .delete(targetEmbeddings)
            .where(eq(targetEmbeddings.userId, user.id));
        });
        return Response.json(data);
      }
    }
    if (route === "preferences") {
      if (method === "GET") {
        const [row] = await db
          .select()
          .from(preferences)
          .where(eq(preferences.userId, user.id));
        return Response.json(
          preferencesSchema.parse(row?.data ?? defaultPreferences),
        );
      }
      if (method === "PUT") {
        const data = preferencesSchema.parse(await readJson(request));
        await db.transaction(async (tx) => {
          await tx
            .update(preferences)
            .set({ data, updatedAt: new Date() })
            .where(eq(preferences.userId, user.id));
          await tx
            .delete(targetEmbeddings)
            .where(eq(targetEmbeddings.userId, user.id));
        });
        return Response.json(data);
      }
    }
    if (route === "resumes" && method === "GET") {
      const rows = await db
        .select({
          id: resumes.id,
          filename: resumes.filename,
          size: resumes.size,
          createdAt: resumes.createdAt,
        })
        .from(resumes)
        .where(eq(resumes.userId, user.id))
        .orderBy(desc(resumes.createdAt));
      return Response.json(rows);
    }
    if (route === "resumes" && method === "POST") {
      await rateLimit(`upload:${user.id}`, 10, 3600);
      const bytes = await readBody(request, maxResumeBytes + 16384);
      const form = await new Request(request.url, {
        method: "POST",
        headers: { "content-type": request.headers.get("content-type") ?? "" },
        body: bytes,
      }).formData();
      const file = form.get("file");
      if (!(file instanceof File))
        throw new HttpError(400, "Choose a resume file.");
      const original = Buffer.from(await file.arrayBuffer());
      const filename = file.name
        .replace(/[\/\\\r\n\x00-\x1f]/g, "_")
        .slice(0, 200);
      const extracted = await extractResume(filename, original);
      const result = await db.transaction(async (tx) => {
        // Serialize per-user uploads to enforce the storage cap even with concurrent requests.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`,
        );
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(resumes)
          .where(eq(resumes.userId, user.id));
        if (count >= 10)
          throw new HttpError(
            400,
            "You can store up to 10 resumes. Delete an older version first.",
          );
        const [row] = await tx
          .insert(resumes)
          .values({
            userId: user.id,
            filename,
            mimeType: extracted.mimeType,
            size: original.length,
            originalBase64: original.toString("base64"),
            extractedText: extracted.text,
          })
          .returning({
            id: resumes.id,
            filename: resumes.filename,
            extractedText: resumes.extractedText,
          });
        await tx
          .insert(auditEvents)
          .values({ userId: user.id, action: "resume.uploaded" });
        return row;
      });
      return Response.json(result, { status: 201 });
    }
    if (path[0] === "resumes" && path.length === 2) {
      const id = z.uuid().parse(path[1]);
      const [resume] = await db
        .select()
        .from(resumes)
        .where(and(eq(resumes.id, id), eq(resumes.userId, user.id)));
      if (!resume) throw new HttpError(404, "Resume not found.");
      if (method === "GET")
        return new Response(Buffer.from(resume.originalBase64, "base64"), {
          headers: {
            "Content-Type": resume.mimeType,
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(resume.filename)}`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      if (method === "DELETE") {
        await db
          .delete(resumes)
          .where(and(eq(resumes.id, id), eq(resumes.userId, user.id)));
        return Response.json({ ok: true });
      }
    }
    if (route === "jobs") {
      if (method === "GET")
        return Response.json(
          await listJobs(user.id, new URL(request.url).searchParams),
        );
      if (method === "POST") {
        await rateLimit(`jobs:${user.id}`, 60, 3600);
        return Response.json(
          await createJob(user.id, await readJson(request)),
          { status: 201 },
        );
      }
    }
    if (path[0] === "jobs" && path.length >= 2) {
      const id = z.uuid().parse(path[1]);
      if (path.length === 2 && method === "GET")
        return Response.json(await getJob(user.id, id));
      if (path.length === 3 && path[2] === "evaluate" && method === "POST") {
        await rateLimit(`ai-evaluate:${user.id}`, 20, 3600);
        const result = await evaluateJob(user.id, id);
        if (result.match) await alertOnMatches(user.id);
        return Response.json(result);
      }
      if (path.length === 3 && path[2] === "status" && method === "PUT")
        return Response.json(
          await updateStatus(user.id, id, await readJson(request)),
        );
      if (path.length === 3 && path[2] === "archive" && method === "PUT")
        return Response.json(
          await setArchived(user.id, id, await readJson(request)),
        );
    }
    throw new HttpError(404, "Endpoint not found.");
  } catch (error) {
    if (activityUserId && !["GET", "HEAD"].includes(request.method))
      await recordActivity(getDb(), {
        userId: activityUserId,
        actor: "Application",
        stage: "request-failed",
        level: "error",
        message:
          "The requested application action failed. See the error shown by the action or its scan details.",
      }).catch(() => undefined);
    return errorResponse(error);
  }
}
async function route(request: Request, context: Context) {
  const response = await handle(request, context);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
export { route as GET, route as POST, route as PUT, route as DELETE };
