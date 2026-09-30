import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio server advertises all five tools and rejects malformed dispatch", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/mcp.js")],
    cwd: process.cwd(),
    env: { ...process.env, ORCHESTRATOR_REPO_ROOT: process.cwd() } as Record<
      string,
      string
    >,
    stderr: "pipe",
  });
  const client = new Client({ name: "orchestrator-fixture", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "dispatch_tasks",
        "get_run_status",
        "collect_run_results",
        "cancel_run",
        "cleanup_run",
      ].sort(),
    );
    const invalid = await client.callTool({
      name: "dispatch_tasks",
      arguments: { tasks: [] },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
  }
});
