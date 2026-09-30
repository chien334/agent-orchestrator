import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator.js";

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-test-"));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  await mkdir(repo);
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  await symlink("/usr/bin/git", join(bin, "git"));
  git(repo, "init", "-q");
  await writeFile(join(repo, "README.md"), "base\n");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Test",
    "commit",
    "-qm",
    "initial",
  );
  await writeFile(
    join(bin, "opencode"),
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--help')) { console.log('opencode run --format json --model'); process.exit(0); }
if (process.env.PWD !== process.cwd()) { console.error('wrong working directory'); process.exit(4); }
const prompt = process.argv.at(-1);
if (process.argv.includes('--model') && process.argv[process.argv.indexOf('--model') + 1] !== 'opencode/muse-spark-1.3-contributor-free') process.exit(3);
if (prompt.includes('wait forever')) { setInterval(() => {}, 1000); }
else if (prompt.includes('fail worker')) { console.error('failed'); process.exit(2); }
else if (prompt.includes('needs approval')) { console.error('waiting for approval'); setInterval(() => {}, 1000); }
else { fs.writeFileSync('result.txt', 'worker result'); console.log(JSON.stringify({ final: 'done' })); }
`,
    { mode: 0o755 },
  );
  return {
    dir,
    repo,
    bin,
    close: async () => rm(dir, { recursive: true, force: true }),
  };
}

const task = (task_id: string, description = "Create result") => ({
  task_id,
  description,
  worker: "opencode",
  allowed_paths: ["result.txt"],
  allowed_tests: [["node", "--version"]],
});

async function untilDone(orchestrator: Orchestrator, runId: string) {
  for (let i = 0; i < 100; i++) {
    const reports = await orchestrator.collect(runId);
    if (
      reports.every((report) => !["queued", "running"].includes(report.status))
    )
      return reports;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("Timed out waiting for fixture worker");
}

test("rejects invalid IDs, duplicate tasks, path traversal and symlinks before creating a run", async () => {
  const f = await fixture();
  try {
    const orchestrator = new Orchestrator(f.repo);
    await assert.rejects(orchestrator.dispatch({ tasks: [task("../escape")] }));
    await assert.rejects(
      orchestrator.dispatch({ tasks: [task("same"), task("same")] }),
      /Duplicate/,
    );
    await assert.rejects(
      orchestrator.dispatch({
        tasks: [{ ...task("unsafe"), allowed_paths: ["../outside"] }],
      }),
    );
    await symlink(f.dir, join(f.repo, "linked"));
    await assert.rejects(
      orchestrator.dispatch({
        tasks: [{ ...task("symlink"), allowed_paths: ["linked/secret"] }],
      }),
      /Symlink/,
    );
  } finally {
    await f.close();
  }
});

test("isolates tasks, enforces test argv, persists reports and preserves dirty worktrees on cleanup", async () => {
  const f = await fixture();
  const before = process.env.PATH;
  process.env.PATH = `${f.bin}:${before}`;
  try {
    const orchestrator = new Orchestrator(f.repo, 1);
    const { run_id, tasks } = await orchestrator.dispatch({
      tasks: [task("first"), task("second")],
    });
    assert.notEqual(tasks[0].worktree_path, tasks[1].worktree_path);
    const reports = await untilDone(orchestrator, run_id);
    assert.deepEqual(
      reports.map((report) => report.status),
      ["completed", "completed"],
    );
    assert.deepEqual(reports[0].changed_files, ["result.txt"]);
    assert.equal(reports[0].tests[0].status, "passed");
    assert.equal(await readFile(join(f.repo, "README.md"), "utf8"), "base\n");
    const recovered = new Orchestrator(f.repo);
    assert.equal((await recovered.collect(run_id))[0].status, "completed");
    const cleaned = await recovered.cleanup(run_id);
    assert.equal(cleaned.removed.length, 0);
    assert.equal(cleaned.preserved.length, 2);
  } finally {
    process.env.PATH = before;
    await f.close();
  }
});

test("reports process failures and missing CLI separately", async () => {
  const f = await fixture();
  const before = process.env.PATH;
  process.env.PATH = f.bin;
  try {
    const orchestrator = new Orchestrator(f.repo);
    const { run_id } = await orchestrator.dispatch({
      tasks: [
        task("failure", "fail worker"),
        { ...task("missing"), worker: "agy" },
      ],
    });
    const reports = await untilDone(orchestrator, run_id);
    assert.equal(reports[0].status, "failed");
    assert.equal(reports[0].exit_code, 2);
    assert.equal(reports[1].status, "failed");
    assert.match(reports[1].errors.join(" "), /not installed/);
  } finally {
    process.env.PATH = before;
    await f.close();
  }
});

test("marks interactive approval as blocked and records a failed allowlisted test", async () => {
  const f = await fixture();
  const before = process.env.PATH;
  process.env.PATH = `${f.bin}:${before}`;
  try {
    const orchestrator = new Orchestrator(f.repo);
    const { run_id } = await orchestrator.dispatch({
      tasks: [
        task("approval", "needs approval"),
        { ...task("bad-test"), allowed_tests: [["missing-test-command"]] },
      ],
    });
    const reports = await untilDone(orchestrator, run_id);
    assert.equal(reports[0].status, "blocked");
    assert.match(reports[0].errors.join(" "), /interactively/);
    assert.equal(reports[1].status, "failed");
    assert.deepEqual(reports[1].tests[0].command, ["missing-test-command"]);
    assert.equal(reports[1].tests[0].exit_code, null);
  } finally {
    process.env.PATH = before;
    await f.close();
  }
});

test("passes a verified model as a separate CLI argument and rejects invalid selectors", async () => {
  const f = await fixture();
  const before = process.env.PATH;
  process.env.PATH = `${f.bin}:${before}`;
  try {
    const orchestrator = new Orchestrator(f.repo);
    await assert.rejects(
      orchestrator.dispatch({
        tasks: [{ ...task("invalid"), model: "../../bad" }],
      }),
    );
    const { run_id } = await orchestrator.dispatch({
      tasks: [
        {
          ...task("selected"),
          model: "opencode/muse-spark-1.3-contributor-free",
        },
      ],
    });
    const [report] = await untilDone(orchestrator, run_id);
    assert.equal(report.model, "opencode/muse-spark-1.3-contributor-free");
    assert.equal(report.status, "completed");
  } finally {
    process.env.PATH = before;
    await f.close();
  }
});

test("passes accept-edits and selected model to agy and treats denied actions as blocked", async () => {
  const f = await fixture();
  await writeFile(
    join(f.bin, "agy"),
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--help')) { console.log('agy -p --model --mode accept-edits --output-format'); process.exit(0); }
if (process.env.PWD !== process.cwd() || !process.argv.includes('accept-edits') || !process.argv.includes('gemini-3.8-flash-high')) process.exit(3);
if (process.argv.join(' ').includes('deny changes')) { console.error('permission denied'); console.log(JSON.stringify({status:'SUCCESS',denied_actions:[{action:'write_file'}]})); }
else { fs.writeFileSync('result.txt','agy result'); console.log(JSON.stringify({status:'SUCCESS',response:'done'})); }
`,
    { mode: 0o755 },
  );
  const before = process.env.PATH;
  process.env.PATH = f.bin;
  try {
    const orchestrator = new Orchestrator(f.repo);
    const { run_id } = await orchestrator.dispatch({
      tasks: [
        {
          ...task("agy-denied", "deny changes"),
          worker: "agy",
          model: "gemini-3.8-flash-high",
        },
        {
          ...task("agy-accepted"),
          worker: "agy",
          model: "gemini-3.8-flash-high",
        },
      ],
    });
    const reports = await untilDone(orchestrator, run_id);
    const denied = reports.find(({ task_id }) => task_id === "agy-denied")!;
    const accepted = reports.find(({ task_id }) => task_id === "agy-accepted")!;
    assert.equal(denied.status, "blocked");
    assert.equal(denied.tests.length, 0);
    assert.equal(accepted.status, "completed");
    assert.deepEqual(accepted.changed_files, ["result.txt"]);
  } finally {
    process.env.PATH = before;
    await f.close();
  }
});

test("cancels a running worker and leaves its worktree", async () => {
  const f = await fixture();
  const before = process.env.PATH;
  process.env.PATH = `${f.bin}:${before}`;
  try {
    const orchestrator = new Orchestrator(f.repo);
    const { run_id } = await orchestrator.dispatch({
      tasks: [task("waiting", "wait forever")],
    });
    for (let i = 0; i < 100; i++) {
      if ((await orchestrator.status(run_id))[0].status === "running") break;
      await new Promise((done) => setTimeout(done, 20));
    }
    await orchestrator.cancel(run_id);
    const reports = await untilDone(orchestrator, run_id);
    assert.equal(reports[0].status, "cancelled");
    assert.ok(
      await readFile(join(reports[0].worktree_path, "README.md"), "utf8"),
    );
  } finally {
    process.env.PATH = before;
    await f.close();
  }
});

test("cleans a clean worktree but preserves its branch", async () => {
  const f = await fixture();
  const before = process.env.PATH;
  process.env.PATH = f.bin;
  try {
    const orchestrator = new Orchestrator(f.repo);
    const { run_id } = await orchestrator.dispatch({
      tasks: [{ ...task("no-cli"), worker: "agy" }],
    });
    const [report] = await untilDone(orchestrator, run_id);
    assert.equal(report.status, "failed");
    const cleaned = await orchestrator.cleanup(run_id);
    assert.deepEqual(cleaned.removed, [report.worktree_path]);
    const branches = spawnSync("git", ["branch", "--list", report.branch], {
      cwd: f.repo,
      encoding: "utf8",
    });
    assert.match(branches.stdout, /orchestrator\//);
    await assert.rejects(orchestrator.collect(run_id));
  } finally {
    process.env.PATH = before;
    await f.close();
  }
});

test("partial cleanup can be retried after a dirty worktree is inspected", async () => {
  const f = await fixture();
  const before = process.env.PATH;
  process.env.PATH = f.bin;
  try {
    const orchestrator = new Orchestrator(f.repo);
    const { run_id } = await orchestrator.dispatch({
      tasks: [
        { ...task("clean"), worker: "agy" },
        { ...task("dirty"), worker: "opencode" },
      ],
    });
    const reports = await untilDone(orchestrator, run_id);
    const first = await orchestrator.cleanup(run_id);
    assert.deepEqual(first.removed, [reports[0].worktree_path]);
    assert.deepEqual(first.preserved, [reports[1].worktree_path]);
    await rm(join(reports[1].worktree_path, "result.txt"));
    const retry = await orchestrator.cleanup(run_id);
    assert.equal(retry.removed.length, 2);
    assert.equal(retry.preserved.length, 0);
  } finally {
    process.env.PATH = before;
    await f.close();
  }
});

test("recovers an interrupted report without deleting its worktree", async () => {
  const f = await fixture();
  const before = process.env.PATH;
  process.env.PATH = f.bin;
  try {
    const original = new Orchestrator(f.repo);
    const { run_id } = await original.dispatch({
      tasks: [{ ...task("interrupted"), worker: "agy" }],
    });
    const [report] = await untilDone(original, run_id);
    report.status = "running";
    await writeFile(
      join(report.log_path, "..", "report.json"),
      JSON.stringify(report),
    );
    const recovered = new Orchestrator(f.repo);
    const [after] = await recovered.collect(run_id);
    assert.equal(after.status, "failed");
    assert.match(after.errors.join(" "), /state lost/);
    assert.ok(await readFile(join(after.worktree_path, "README.md"), "utf8"));
  } finally {
    process.env.PATH = before;
    await f.close();
  }
});
