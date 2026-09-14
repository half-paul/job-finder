import { desc, eq } from "drizzle-orm";
import { getDb, profiles, resumes } from "@jobfinder/db";
import { pageUser } from "../../../lib/auth";
import { ProfileForm } from "../../../components/profile-form";
export default async function Page() {
  const user = await pageUser();
  const db = getDb();
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, user.id));
  const files = await db
    .select({ id: resumes.id, filename: resumes.filename, size: resumes.size })
    .from(resumes)
    .where(eq(resumes.userId, user.id))
    .orderBy(desc(resumes.createdAt));
  return <ProfileForm initial={profile.data} resumes={files} />;
}
