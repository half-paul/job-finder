import { requireUser } from "../../../lib/auth";
import { alerts } from "../../../lib/automation";
import { NotificationsList } from "../../../components/notifications-list";

export const dynamic = "force-dynamic";

export default async function Page() {
  const rows = await alerts.list((await requireUser()).id);
  return <NotificationsList rows={rows} />;
}
