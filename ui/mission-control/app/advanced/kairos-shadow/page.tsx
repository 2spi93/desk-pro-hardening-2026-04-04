import { redirect } from "next/navigation";

import { getServerRoleGroup } from "../../../lib/serverAuth";
import KairosShadowClient from "./KairosShadowClient";

export default async function KairosShadowPage() {
  const roleGroup = await getServerRoleGroup();
  if (roleGroup === "client") redirect("/terminal");
  return <KairosShadowClient />;
}
