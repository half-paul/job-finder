import { requireUser } from "../../../lib/auth";
import { automation } from "../../../lib/automation";
import { AutomationBoard } from "../../../components/automation-board";

export const dynamic = "force-dynamic";

export default async function Page() {
  const overview = await automation.overview((await requireUser()).id);
  return <AutomationBoard overview={overview} />;
}
