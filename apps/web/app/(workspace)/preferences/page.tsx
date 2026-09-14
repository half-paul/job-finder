import { eq } from "drizzle-orm";
import { getDb, preferences } from "@jobfinder/db";
import { pageUser } from "../../../lib/auth";
import { PreferencesForm } from "../../../components/preferences-form";
export default async function Page() {
  const user = await pageUser();
  const [row] = await getDb()
    .select()
    .from(preferences)
    .where(eq(preferences.userId, user.id));
  return <PreferencesForm initial={row.data} />;
}
