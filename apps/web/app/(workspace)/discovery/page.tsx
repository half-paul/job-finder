import { requireUser } from "../../../lib/auth";
import { listSources } from "../../../lib/discovery";
import { DiscoveryBoard } from "../../../components/discovery-board";

export const dynamic = "force-dynamic";

export default async function Page() {
  const sources = await listSources((await requireUser()).id);
  return <DiscoveryBoard sources={sources} />;
}
