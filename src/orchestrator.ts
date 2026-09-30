import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  lstat,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  dispatchSchema,
  runSchema,
  assertUnique,
  modelSchema,
  type Report,
  type TaskInput,
} from "./contracts.js";

const terminal = new Set(["completed", "failed", "blocked", "cancelled"]);
const secret =
  /(?:\b(?:api[_-]?key|token|password|secret|authorization|credential)\b\s*[:=]\s*|Bearer\s+)\S+/gi;
const sanitize = (text: string): string =>
  text
    .replace(secret, "[REDACTED]")
    .replace(/^\s*[A-Z][A-Z0-9_]*=.+$/gm, "[REDACTED]")
    .slice(-12000);

function deniedActions(output: string): boolean {
  // Some CLIs emit diagnostics on stderr before the final JSON line.
  for (const line of output.split("\n")) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "denied_actions" in parsed &&
        Array.isArray(parsed.denied_actions) &&
        parsed.denied_actions.length > 0
      )
        return true;
    } catch {
      /* Diagnostic text is not JSON. */
    }
  }
  return false;
}

function finalResponse(output: string, worker: TaskInput["worker"]): string {
  const lines = output.split("\n");
  for (const line of lines.reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null) continue;
      if (
        worker === "agy" &&
        "response" in value &&
        typeof value.response === "string"
      )
        return sanitize(value.response);
      if (
        worker === "opencode" &&
        "type" in value &&
        value.type === "text" &&
        "part" in value &&
        typeof value.part === "object" &&
        value.part !== null &&
        "text" in value.part &&
        typeof value.part.text === "string"
      )
        return sanitize(value.part.text);
    } catch {
      /* A diagnostic line is not a JSON result. */
    }
  }
  return sanitize(output.slice(-500));
}

async function execute(
  executable: string,
  args: string[],
  cwd: string,
  timeout = 30000,
): Promise<{ code: number; output: string }> {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PWD: cwd, GIT_TERMINAL_PROMPT: "0" },
    });
    let output = "";
    const collect = (data: Buffer) => {
      output = (output + data.toString()).slice(-1024 * 1024);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, 2000).unref();
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, output });
    });
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execute("git", args, cwd);
  if (result.code !== 0)
    throw new Error(`git ${args[0]} failed: ${sanitize(result.output)}`);
  return result.output.trim();
}

async function validatePaths(root: string, paths: string[]): Promise<void> {
  for (const item of paths) {
    const target = resolve(root, item);
    if (!target.startsWith(root + sep))
      throw new Error(`Path outside repository: ${item}`);
    let current = root;
    for (const part of item.split("/")) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink())
          throw new Error(`Symlink not allowed: ${item}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
  }
}

type Entry = { task: TaskInput; report: Report };
export type DashboardTask = Pick<
  Report,
  | "task_id"
  | "worker"
  | "model"
  | "status"
  | "summary"
  | "worktree_path"
  | "branch"
  | "changed_files"
  | "tests"
  | "exit_code"
  | "started_at"
  | "finished_at"
  | "log_path"
  | "diff_path"
  | "errors"
>;
export type RunSnapshot = { run_id: string; tasks: DashboardTask[] };
export class Orchestrator {
  private readonly active = new Map<string, ChildProcess>();
  private readonly live = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly queue: Entry[] = [];
  private running = 0;
  private readonly limit: number;
  private root = "";
  private base = "";

  constructor(
    private readonly workspace: string,
    maxWorkers = 3,
  ) {
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 16)
      throw new Error("ORCHESTRATOR_MAX_WORKERS must be 1–16");
    this.limit = maxWorkers;
  }

  private async ready(): Promise<void> {
    if (this.root) return;
    const root = await git(this.workspace, ["rev-parse", "--show-toplevel"]);
    this.root = await realpath(root);
    this.base = await realpath(
      await git(this.root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
    if (this.base === this.root || !isAbsolute(this.base))
      throw new Error("Invalid Git metadata location");
  }

  private directory(runId: string): string {
    return join(this.base, "agent-orchestrator", "runs", runId);
  }
  private reportPath(runId: string, taskId: string): string {
    return join(this.directory(runId), taskId, "report.json");
  }
  private async save(report: Report): Promise<void> {
    const path = this.reportPath(report.run_id, report.task_id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    await rename(temporary, path);
  }
  private async reports(runId: string): Promise<Report[]> {
    await this.ready();
    runSchema.parse({ run_id: runId });
    const ids = (await readdir(this.directory(runId))).filter(
      (id) => !id.endsWith(".tmp"),
    );
    return Promise.all(
      ids.map(async (id) => {
        const report = JSON.parse(
          await readFile(this.reportPath(runId, id), "utf8"),
        ) as Report;
        if (
          (report.status === "running" || report.status === "queued") &&
          !this.live.has(`${runId}/${id}`)
        ) {
          report.status = "failed";
          report.summary = "MCP server interrupted before completion";
          report.errors.push(
            "Worker state lost after server restart; inspect worktree before retrying",
          );
          report.finished_at = new Date().toISOString();
          await this.save(report);
        }
        return report;
      }),
    );
  }

  /** Read-only view for the dashboard. Never reconciles a different process's live run. */
  async listRunSnapshots(): Promise<RunSnapshot[]> {
    await this.ready();
    const runsPath = join(this.base, "agent-orchestrator", "runs");
    let directories;
    try {
      directories = (await readdir(runsPath, { withFileTypes: true })).filter(
        (entry) =>
          entry.isDirectory() &&
          runSchema.safeParse({ run_id: entry.name }).success,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const dates = await Promise.all(
      directories.map(async (entry) => {
        try {
          return {
            id: entry.name,
            updated: (await stat(join(runsPath, entry.name))).mtimeMs,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      }),
    );
    const dated = dates.filter(
      (item): item is NonNullable<typeof item> => item !== null,
    );
    dated.sort((a, b) => b.updated - a.updated);
    const snapshots = await Promise.all(
      dated.slice(0, 50).map(async ({ id }) => {
        let entries;
        try {
          entries = await readdir(this.directory(id), { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
        const taskDirs = entries.filter(
          (entry) =>
            entry.isDirectory() &&
            /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.name),
        );
        const tasks = await Promise.all(
          taskDirs.map(async (entry): Promise<DashboardTask | null> => {
            try {
              const report = JSON.parse(
                await readFile(this.reportPath(id, entry.name), "utf8"),
              ) as Report;
              const {
                task_id,
                worker,
                model,
                status,
                summary,
                worktree_path,
                branch,
                changed_files,
                tests,
                exit_code,
                started_at,
                finished_at,
                log_path,
                diff_path,
                errors,
              } = report;
              return {
                task_id,
                worker,
                model,
                status,
                summary,
                worktree_path,
                branch,
                changed_files,
                tests: tests.map(({ command, exit_code, status }) => ({
                  command,
                  exit_code,
                  status,
                })),
                exit_code,
                started_at,
                finished_at,
                log_path,
                diff_path,
                errors,
              };
            } catch {
              return null;
            } // Ignore a report being atomically replaced.
          }),
        );
        return {
          run_id: id,
          tasks: tasks.filter((item): item is DashboardTask => item !== null),
        };
      }),
    );
    return snapshots.filter((item): item is RunSnapshot => item !== null);
  }

  async dispatch(input: unknown): Promise<{ run_id: string; tasks: Report[] }> {
    await this.ready();
    const { tasks } = dispatchSchema.parse(input);
    assertUnique(tasks);
    for (const task of tasks) {
      await validatePaths(this.root, task.allowed_paths);
      const selected =
        task.model ??
        process.env[
          task.worker === "opencode"
            ? "ORCHESTRATOR_OPENCODE_MODEL"
            : "ORCHESTRATOR_AGY_MODEL"
        ];
      if (selected) modelSchema.parse(selected);
    }
    const runId = randomUUID();
    const revision = await git(this.root, ["rev-parse", "HEAD"]);
    const entries: Entry[] = [];
    for (const task of tasks) {
      const branch = `orchestrator/${runId}/${task.task_id}`;
      const worktree = join(
        this.base,
        "agent-orchestrator",
        "trees",
        runId,
        task.task_id,
      );
      const dir = join(this.directory(runId), task.task_id);
      const report: Report = {
        run_id: runId,
        task_id: task.task_id,
        worker: task.worker,
        model:
          task.model ??
          process.env[
            task.worker === "opencode"
              ? "ORCHESTRATOR_OPENCODE_MODEL"
              : "ORCHESTRATOR_AGY_MODEL"
          ] ??
          null,
        status: "queued",
        summary: "Waiting for worker",
        worktree_path: worktree,
        branch,
        changed_files: [],
        tests: [],
        exit_code: null,
        started_at: null,
        finished_at: null,
        log_path: join(dir, "events.log"),
        diff_path: join(dir, "diff.stat"),
        errors: [],
        final_response: "",
        base_commit: revision,
      };
      await this.save(report);
      try {
        await mkdir(dirname(worktree), { recursive: true });
        await git(this.root, [
          "worktree",
          "add",
          "-b",
          branch,
          worktree,
          revision,
        ]);
        await this.save(report);
        entries.push({ task, report });
      } catch (error) {
        report.status = "failed";
        report.finished_at = new Date().toISOString();
        report.errors.push(sanitize(String(error)));
        await this.save(report);
      }
    }
    for (const entry of entries)
      this.live.add(`${runId}/${entry.task.task_id}`);
    this.queue.push(...entries);
    this.pump();
    return { run_id: runId, tasks: await this.reports(runId) };
  }

  private pump(): void {
    while (this.running < this.limit && this.queue.length) {
      const entry = this.queue.shift()!;
      this.running++;
      void this.run(entry).finally(() => {
        this.live.delete(`${entry.report.run_id}/${entry.task.task_id}`);
        this.running--;
        this.pump();
      });
    }
  }

  private async log(report: Report, message: string): Promise<void> {
    await writeFile(
      report.log_path,
      `${new Date().toISOString()} ${sanitize(message)}\n`,
      { flag: "a", mode: 0o600 },
    );
  }

  private async worker(
    executable: string,
    args: string[],
    report: Report,
  ): Promise<{ code: number; output: string; blocked: boolean }> {
    return new Promise((done, reject) => {
      const child = spawn(executable, args, {
        cwd: report.worktree_path,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: {
          ...process.env,
          PWD: report.worktree_path,
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      this.active.set(`${report.run_id}/${report.task_id}`, child);
      if (this.cancelled.has(report.run_id)) this.stop(child);
      let output = "";
      let blocked = false;
      const collect = (data: Buffer) => {
        output = (output + data.toString()).slice(-1024 * 1024);
        if (
          /waiting for approval|approve to continue|press (enter|y) to continue|login required|authentication required/i.test(
            output.slice(-512),
          )
        ) {
          blocked = true;
          this.stop(child);
        }
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(
        () => {
          blocked = true;
          this.stop(child);
        },
        30 * 60 * 1000,
      );
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code: code ?? -1, output, blocked });
      });
    });
  }

  private stop(child: ChildProcess): void {
    if (!child.pid) return;
    const pid = child.pid;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, 2000).unref();
  }

  private async run({ task, report }: Entry): Promise<void> {
    const key = `${report.run_id}/${report.task_id}`;
    if (this.cancelled.has(report.run_id)) return this.finishCancelled(report);
    report.status = "running";
    report.started_at = new Date().toISOString();
    await this.save(report);
    await this.log(report, `started ${task.worker}`);
    try {
      const help = await execute(
        task.worker === "agy" ? "agy" : "opencode",
        task.worker === "agy" ? ["--help"] : ["run", "--help"],
        report.worktree_path,
        10000,
      );
      if (help.code !== 0)
        throw new Error(`${task.worker} CLI unavailable or --help failed`);
      if (task.worker === "agy" && !help.output.includes("-p"))
        throw new Error("agy does not support -p headless mode");
      if (task.worker === "opencode" && !help.output.includes("run"))
        throw new Error("opencode run unavailable");
      if (task.worker === "agy" && !help.output.includes("accept-edits"))
        throw new Error("agy cannot run in accept-edits mode headlessly");
      if (report.model && !help.output.includes("--model"))
        throw new Error(
          `${task.worker} CLI does not support --model; cannot select ${report.model}`,
        );
      if (this.cancelled.has(report.run_id))
        throw new Error("Cancelled before worker launch");
      const prompt = `${task.description}\n\nOnly edit these repository-relative paths: ${task.allowed_paths.join(", ")}. Allowed tests (argv arrays): ${JSON.stringify(task.allowed_tests)}. ${task.worker === "agy" ? "Do not use command/shell tools; the coordinator runs the permitted tests after your edit. Use file tools only." : "Only run tests from the allowlist."} Do not call agent-orchestrator MCP tools or dispatch other workers. Do not commit, merge, push, delete branches or worktrees. If approval is needed, stop and explain. Report your final changes and test outcomes.`;
      const args =
        task.worker === "opencode"
          ? [
              "run",
              "--standalone",
              "--format",
              "json",
              ...(report.model ? ["--model", report.model] : []),
              prompt,
            ]
          : [
              "-p",
              prompt,
              "--mode",
              "accept-edits",
              ...(report.model ? ["--model", report.model] : []),
              ...(help.output.includes("--output-format")
                ? ["--output-format", "json"]
                : []),
            ];
      const result = await this.worker(task.worker, args, report);
      report.exit_code = result.code;
      report.final_response = finalResponse(result.output, task.worker);
      if (this.cancelled.has(report.run_id)) report.status = "cancelled";
      else if (
        result.blocked ||
        deniedActions(result.output) ||
        (/permission|approval|confirm|login|authenticate|sign.?in|interactive/i.test(
          result.output,
        ) &&
          result.code !== 0)
      ) {
        report.status = "blocked";
        report.errors.push(
          `CLI needs interaction; run ${task.worker} interactively in ${report.worktree_path}`,
        );
      } else if (result.code !== 0) {
        report.status = "failed";
        report.errors.push(`${task.worker} exited ${result.code}`);
      } else {
        report.status = "completed";
        for (const [index, command] of task.allowed_tests.entries()) {
          if (this.cancelled.has(report.run_id)) {
            report.status = "cancelled";
            break;
          }
          // Only execute the exact argv vectors supplied at dispatch, never a shell.
          try {
            const outcome = await execute(
              command[0],
              command.slice(1),
              report.worktree_path,
              120000,
            );
            report.tests.push({
              command,
              exit_code: outcome.code,
              status: outcome.code === 0 ? "passed" : "failed",
              error: outcome.code === 0 ? undefined : sanitize(outcome.output),
            });
            await this.log(report, `test #${index + 1} exited ${outcome.code}`);
            if (outcome.code !== 0) report.status = "failed";
          } catch (error) {
            report.tests.push({
              command,
              exit_code: null,
              status: "failed",
              error: sanitize(String(error)),
            });
            report.status = "failed";
          }
        }
      }
    } catch (error) {
      report.status = this.cancelled.has(report.run_id)
        ? "cancelled"
        : "failed";
      report.errors.push(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `${task.worker} CLI not installed or executable unavailable`
          : sanitize(String(error)),
      );
    } finally {
      this.active.delete(key);
      try {
        const base = report.base_commit;
        const changed = await git(report.worktree_path, [
          "diff",
          "--name-only",
          "-z",
          base,
        ]);
        const untracked = await git(report.worktree_path, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ]);
        report.changed_files = [
          ...new Set(
            [...changed.split("\0"), ...untracked.split("\0")].filter(Boolean),
          ),
        ];
        const stat = await git(report.worktree_path, ["diff", "--stat", base]);
        await writeFile(report.diff_path, stat, { mode: 0o600 });
        const outside = report.changed_files.filter(
          (file) =>
            !task.allowed_paths.some(
              (allowed) => file === allowed || file.startsWith(allowed + "/"),
            ),
        );
        if (outside.length) {
          report.status = "failed";
          report.errors.push(
            `Changed outside allowed paths: ${outside.join(", ")}`,
          );
        }
      } catch (error) {
        report.errors.push(
          `Diff inspection failed: ${sanitize(String(error))}`,
        );
        report.status = "failed";
      }
      report.summary =
        report.status === "completed"
          ? "Worker exited successfully; inspect diff before accepting"
          : `Worker ${report.status}`;
      report.finished_at = new Date().toISOString();
      await this.log(report, report.summary);
      await this.save(report);
    }
  }

  private async finishCancelled(report: Report): Promise<void> {
    report.status = "cancelled";
    report.finished_at = new Date().toISOString();
    report.summary = "Cancelled before start";
    await this.save(report);
  }

  async status(runId: string): Promise<Report[]> {
    const reports = await this.reports(runId);
    return reports.map((report) => ({
      ...report,
      final_response: "",
      duration_ms: report.started_at
        ? new Date(report.finished_at ?? Date.now()).getTime() -
          new Date(report.started_at).getTime()
        : 0,
    }));
  }
  async collect(runId: string): Promise<Report[]> {
    return this.reports(runId);
  }
  async cancel(runId: string): Promise<Report[]> {
    const reports = await this.reports(runId);
    this.cancelled.add(runId);
    for (const report of reports) {
      if (report.status === "queued") await this.finishCancelled(report);
      if (report.status === "running") {
        const child = this.active.get(`${runId}/${report.task_id}`);
        if (child) this.stop(child);
      }
    }
    this.queue.splice(
      0,
      this.queue.length,
      ...this.queue.filter(({ report }) => report.run_id !== runId),
    );
    for (const report of reports)
      if (report.status === "queued")
        this.live.delete(`${runId}/${report.task_id}`);
    return this.status(runId);
  }
  async cleanup(
    runId: string,
  ): Promise<{ removed: string[]; preserved: string[] }> {
    const reports = await this.reports(runId);
    if (reports.some((report) => !terminal.has(report.status)))
      throw new Error("Run still active; cancel it first");
    const removed: string[] = [];
    const preserved: string[] = [];
    for (const report of reports) {
      try {
        const registered = (
          await git(this.root, ["worktree", "list", "--porcelain"])
        )
          .split("\n")
          .includes(`worktree ${report.worktree_path}`);
        if (!registered) {
          removed.push(report.worktree_path);
          continue;
        }
        const current = await git(report.worktree_path, [
          "status",
          "--porcelain",
        ]);
        if (current) {
          preserved.push(report.worktree_path);
          continue;
        }
        await git(this.root, ["worktree", "remove", report.worktree_path]);
        removed.push(report.worktree_path);
      } catch {
        preserved.push(report.worktree_path);
      }
    }
    if (preserved.length === 0)
      await rm(this.directory(runId), { recursive: true });
    return { removed, preserved };
  }
}
