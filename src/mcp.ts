import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Orchestrator } from "./orchestrator.js";
import { dispatchSchema, runSchema } from "./contracts.js";

const count =
  process.env.ORCHESTRATOR_MAX_WORKERS === undefined
    ? 3
    : Number(process.env.ORCHESTRATOR_MAX_WORKERS);
const orchestrator = new Orchestrator(
  process.env.ORCHESTRATOR_REPO_ROOT ?? process.cwd(),
  count,
);
const server = new McpServer({ name: "agent-orchestrator", version: "1.0.0" });

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
function failure(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : "Unknown error",
      },
    ],
  };
}

server.tool(
  "dispatch_tasks",
  "Create one Git worktree per task and start bounded CLI workers",
  dispatchSchema.shape,
  async (input) => {
    try {
      return result(await orchestrator.dispatch(input));
    } catch (error) {
      return failure(error);
    }
  },
);
server.tool(
  "get_run_status",
  "Read worker status and elapsed time",
  runSchema.shape,
  async ({ run_id }) => {
    try {
      return result(await orchestrator.status(run_id));
    } catch (error) {
      return failure(error);
    }
  },
);
server.tool(
  "collect_run_results",
  "Read final results and diff/log locations (review changes manually)",
  runSchema.shape,
  async ({ run_id }) => {
    try {
      return result(await orchestrator.collect(run_id));
    } catch (error) {
      return failure(error);
    }
  },
);
server.tool(
  "cancel_run",
  "Stop active workers without removing branches or worktrees",
  runSchema.shape,
  async ({ run_id }) => {
    try {
      return result(await orchestrator.cancel(run_id));
    } catch (error) {
      return failure(error);
    }
  },
);
server.tool(
  "cleanup_run",
  "Remove clean worktrees and run logs only after explicit confirmation; preserve branches and dirty worktrees",
  { ...runSchema.shape, confirm: z.literal(true) },
  async ({ run_id }) => {
    try {
      return result(await orchestrator.cleanup(run_id));
    } catch (error) {
      return failure(error);
    }
  },
);

await server.connect(new StdioServerTransport());
