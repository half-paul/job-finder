import { requireUser } from "../../../lib/auth";
import { watchlist } from "../../../lib/automation";
import { WatchlistBoard } from "../../../components/watchlist-board";

export const dynamic = "force-dynamic";

export default async function Page() {
  const entries = await watchlist.list((await requireUser()).id);
  return <WatchlistBoard entries={entries} />;
}
