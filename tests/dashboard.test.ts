import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator.js";
import { createDashboardServer } from "../src/dashboard-server.js";

test("dashboard snapshots list reports without marking an active worker interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-fixture-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "README.md"), "fixture\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "init",
      ],
      { cwd: root },
    );
    const manager = new Orchestrator(root);
    assert.deepEqual(await manager.listRunSnapshots(), []);
    const runId = "f03afb47-20e4-4e0d-b4b5-08664ff079fb";
    const reportDir = join(
      root,
      ".git",
      "agent-orchestrator",
      "runs",
      runId,
      "example",
    );
    await mkdir(reportDir, { recursive: true });
    const source = {
      run_id: runId,
      task_id: "example",
      worker: "agy",
      model: "gemini-3.8-flash-high",
      status: "running",
      summary: "Working",
      worktree_path: join(root, "worktree"),
      branch: "orchestrator/example",
      changed_files: [],
      tests: [],
      exit_code: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      log_path: join(reportDir, "events.log"),
      diff_path: join(reportDir, "diff.stat"),
      errors: [],
      final_response: "private worker message",
      base_commit: "abc",
    };
    const file = join(reportDir, "report.json");
    await writeFile(file, JSON.stringify(source));
    const snapshots = await manager.listRunSnapshots();
    assert.equal(snapshots[0].tasks[0].status, "running");
    assert.equal(snapshots[0].tasks[0].worker, "agy");
    assert.equal(
      JSON.stringify(snapshots).includes("private worker message"),
      false,
    );
    assert.equal(JSON.parse(await readFile(file, "utf8")).status, "running");
    const server = await createDashboardServer(root);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No server address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/runs`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.text();
      assert.equal(body.includes("private worker message"), false);
      assert.equal(JSON.parse(body).runs[0].tasks[0].status, "running");
      assert.equal(
        (await fetch(`http://127.0.0.1:${address.port}/`)).status,
        200,
      );
      assert.equal(
        (await fetch(`http://127.0.0.1:${address.port}/missing`)).status,
        404,
      );
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
