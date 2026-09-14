import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import {
  getDb,
  users,
  sessions,
  rateLimits,
  profiles,
  preferences,
  auditEvents,
} from "@jobfinder/db";
import {
  authSchema,
  emptyProfile,
  defaultPreferences,
} from "@jobfinder/shared";
import { digest, hashPassword, verifyPassword } from "./security";
import { HttpError, origin } from "./http";
const cookieName = "jobfinder_session";
export async function rateLimit(key: string, max = 10, windowSeconds = 900) {
  const db = getDb();
  const now = new Date();
  const [row] = await db
    .insert(rateLimits)
    .values({
      key: digest(key),
      count: 1,
      expiresAt: new Date(Date.now() + windowSeconds * 1000),
    })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`CASE WHEN ${rateLimits.expiresAt} < ${now} THEN 1 ELSE ${rateLimits.count} + 1 END`,
        expiresAt: sql`CASE WHEN ${rateLimits.expiresAt} < ${now} THEN ${new Date(Date.now() + windowSeconds * 1000)} ELSE ${rateLimits.expiresAt} END`,
      },
    })
    .returning();
  if (row.count > max)
    throw new HttpError(429, "Too many attempts. Please try again later.");
}
export async function currentUser() {
  const token = (await cookies()).get(cookieName)?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [result] = await getDb()
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, digest(token)),
        gt(sessions.expiresAt, new Date()),
      ),
    );
  return result ?? null;
}
export async function requireUser() {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Please sign in.");
  return user;
}
export async function pageUser() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}
export async function authenticate(body: unknown, register: boolean) {
  const input = authSchema.parse(body);
  await rateLimit("auth:global", 60, 60);
  await rateLimit(`auth:${input.email}`);
  const db = getDb();
  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, input.email));
  if (register) {
    const passwordHash = await hashPassword(input.password);
    if (user)
      throw new HttpError(
        409,
        "An account could not be created with these details. Try signing in.",
      );
    user = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          email: input.email,
          name: input.name || input.email.split("@")[0],
          passwordHash,
        })
        .onConflictDoNothing()
        .returning();
      if (!created)
        throw new HttpError(
          409,
          "An account could not be created with these details.",
        );
      await tx.insert(profiles).values({
        userId: created.id,
        data: { ...emptyProfile, name: created.name },
      });
      await tx
        .insert(preferences)
        .values({ userId: created.id, data: defaultPreferences });
      await tx
        .insert(auditEvents)
        .values({ userId: created.id, action: "account.created" });
      return created;
    });
  } else {
    const dummyHash = `scrypt-v1:${"0".repeat(32)}:${"0".repeat(128)}`;
    const valid = await verifyPassword(
      input.password,
      user?.passwordHash ?? dummyHash,
    );
    if (!user || !valid)
      throw new HttpError(401, "Email or password is incorrect.");
  }
  const jar = await cookies();
  const previous = jar.get(cookieName)?.value;
  if (previous)
    await db.delete(sessions).where(eq(sessions.tokenHash, digest(previous)));
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 86400000);
  await db
    .insert(sessions)
    .values({ tokenHash: digest(token), userId: user.id, expiresAt });
  jar.set(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: origin().startsWith("https:"),
    path: "/",
    expires: expiresAt,
  });
  await db
    .insert(auditEvents)
    .values({ userId: user.id, action: "session.created" });
  return { id: user.id, name: user.name, email: user.email };
}
export async function logout() {
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  if (token)
    await getDb()
      .delete(sessions)
      .where(eq(sessions.tokenHash, digest(token)));
  jar.delete(cookieName);
}
