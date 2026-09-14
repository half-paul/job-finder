import { pageUser } from "../../lib/auth";
import { Shell } from "../../components/shell";
export const dynamic = "force-dynamic";
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await pageUser();
  return <Shell name={user.name}>{children}</Shell>;
}
