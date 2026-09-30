// Run only against a throwaway Git repository with the two test fixtures.
import { basename, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = process.argv[2];
if (!repo)
  throw new Error("Usage: node scripts/smoke.mjs /path/to/throwaway-repo");
if (!basename(resolve(repo)).startsWith("agent-orchestrator-smoke-"))
  throw new Error("Refusing to dispatch into a non-smoke repository");
const selectedWorker = process.argv[3];
if (selectedWorker && !["agy", "opencode"].includes(selectedWorker))
  throw new Error("Optional worker must be agy or opencode");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/mcp.js")],
  cwd: repo,
  env: {
    ...process.env,
    ORCHESTRATOR_OPENCODE_MODEL: "opencode/muse-spark-1.3-contributor-free",
    ORCHESTRATOR_AGY_MODEL: "gemini-3.8-flash-high",
    ORCHESTRATOR_MAX_WORKERS: "2",
  },
});
const client = new Client({ name: "smoke-review", version: "1.0.0" });
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError)
    throw new Error(result.content[0]?.text ?? "MCP tool error");
  return JSON.parse(result.content[0].text);
}

await client.connect(transport);
try {
  const initial = await call("dispatch_tasks", {
    tasks: [
      {
        task_id: "muse-normalize",
        worker: "opencode",
        description:
          "First make a short plan in your response, then fix normalizeName to collapse repeated whitespace between patient name parts. Keep the export and edit only src/normalize.mjs. Run the permitted test and report the result.",
        allowed_paths: ["src/normalize.mjs"],
        allowed_tests: [["node", "--test", "tests/normalize.test.mjs"]],
      },
      {
        task_id: "gemini-slug",
        worker: "agy",
        description:
          "First make a short plan in your response, then implement toSlug so '  Đặng  Văn  A  ' becomes 'dang-van-a'. Keep the export and edit only src/slug.mjs. Do not run commands; the coordinator runs the test after your edit.",
        allowed_paths: ["src/slug.mjs"],
        allowed_tests: [["node", "--test", "tests/slug.test.mjs"]],
      },
    ].filter(({ worker }) => !selectedWorker || worker === selectedWorker),
  });
  console.log("run_id:", initial.run_id);
  const deadline = Date.now() + 180_000;
  let status;
  do {
    await sleep(3000);
    status = await call("get_run_status", { run_id: initial.run_id });
    console.log(
      "status:",
      status.map(({ task_id, status }) => `${task_id}=${status}`).join(" "),
    );
  } while (
    status.some(({ status }) => status === "queued" || status === "running") &&
    Date.now() < deadline
  );
  if (
    status.some(({ status }) => status === "queued" || status === "running")
  ) {
    await call("cancel_run", { run_id: initial.run_id });
    await sleep(3000);
  }
  const results = await call("collect_run_results", { run_id: initial.run_id });
  console.log(
    JSON.stringify(
      results.map(({ final_response, ...rest }) => ({
        ...rest,
        final_response: final_response.slice(-1500),
      })),
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
