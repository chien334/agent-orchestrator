import { createDashboardServer } from "./dashboard-server.js";

const port =
  process.env.ORCHESTRATOR_DASHBOARD_PORT === undefined
    ? 4317
    : Number(process.env.ORCHESTRATOR_DASHBOARD_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("ORCHESTRATOR_DASHBOARD_PORT must be 1–65535");
const server = await createDashboardServer(
  process.env.ORCHESTRATOR_REPO_ROOT ?? process.cwd(),
);
server.listen(port, "127.0.0.1", () => {
  console.log(`Agent runs: http://127.0.0.1:${port}`);
});
