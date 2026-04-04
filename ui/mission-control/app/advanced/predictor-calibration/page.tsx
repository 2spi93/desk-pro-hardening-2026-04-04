import { redirect } from "next/navigation";

import { getServerRoleGroup } from "../../../lib/serverAuth";
import PredictorCalibrationClient from "./PredictorCalibrationClient";

export default async function PredictorCalibrationPage() {
  const roleGroup = await getServerRoleGroup();
  if (roleGroup === "client") redirect("/terminal");
  return <PredictorCalibrationClient />;
}