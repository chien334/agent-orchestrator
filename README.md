# Local CLI Agent Orchestrator

Standalone TypeScript/Node MCP stdio server for OpenCode Desktop. Each task runs in its own Git worktree, on its own branch from the run's starting commit. Supported workers: `opencode run` and `agy -p`. A run may include both worker types. No Desktop GUI automation or automatic merge, commit, cherry-pick, push, or branch deletion.

## Prerequisites and installation

Node.js 20+, npm and Git on macOS/Linux. The target repository must have at least one commit (`HEAD`); its current uncommitted edits are not included in worker worktrees. From this folder:

```sh
npm ci --ignore-scripts
npm run build
git --version
opencode run --help
agy --help
```

`agy` is optional until requested. Check your installed `agy --help` for `-p` and `--output-format`; this server checks help on every task and enables JSON when offered. OpenCode workers use supported `opencode run --format json`; no blanket auto-approval. An unavailable CLI, missing authentication, or a request for interactive confirmation produces a task error or `blocked` with the worktree path. Sign in using that CLI's normal interactive flow yourself. Do not add credentials to this server's configuration.

OpenCode workers use `--standalone` and set `PWD` to the task worktree so a shared background session cannot accidentally read another checkout. Antigravity workers use `--mode accept-edits` (not `--dangerously-skip-permissions`); the coordinator runs allowlisted tests afterward. If Antigravity denies file edits or a required command in headless mode, its JSON `denied_actions` makes the task `blocked`, with its worktree preserved for interactive review.

Model selection uses an optional per-task `model` selector, otherwise `ORCHESTRATOR_OPENCODE_MODEL` or `ORCHESTRATOR_AGY_MODEL` from the MCP server environment. The example config pins `opencode/muse-spark-1.3-contributor-free` and `gemini-3.8-flash-high`, verified with OpenCode's model catalog and `agy models` (CLI 1.2.14). The server checks that the CLI actually supports `--model` before passing it as a separate argument. If a model is unavailable to your account, the task reports the CLI error instead of substituting another model.

## OpenCode V2 configuration

Use `mcp.example.json` as **a fragment reference**, not as a replacement for existing configuration. In the Git repository you intend to dispatch into, add `mcp.servers.agent-orchestrator` and append the three `permissions` entries to that repository's existing `opencode.jsonc` (or `.opencode/opencode.jsonc`). Keep all existing keys and rules. The sample assumes that repository and `agent-orchestrator` are sibling folders. Adjust the command path to point to this built `dist/mcp.js` if they are elsewhere. `cwd: "."` means the target Git repository, so the server refuses dispatch outside it. Do not point `cwd` at the non-Git `hospital-suite` parent. You can use an absolute path to the built JS if your layout differs. Run `opencode mcp list` in the target repository to check the connection.

This package itself also contains `opencode.jsonc` with the built local server and both selected models; `opencode mcp list` from this folder should show `agent-orchestrator connected`. For a different target checkout, copy only the fragment into that checkout and update the JS command path. The current package repository needs a committed baseline before it can be used as a dispatch target.

## Local dashboard

After building, start the **read-only** dashboard in a separate terminal:

```sh
npm run build
npm run dashboard
# Open http://127.0.0.1:4317
```

The dashboard shows up to 50 recent runs: task ID, CLI (`opencode`/`agy`), model, state, elapsed time, test results, changed files, and worktree/branch/log/diff-stat paths. It refreshes every four seconds; click a task row to expand details. To monitor a different Git checkout, run `ORCHESTRATOR_REPO_ROOT=/absolute/path/to/repo npm run dashboard`. Set `ORCHESTRATOR_DASHBOARD_PORT` to change the port. It listens only on `127.0.0.1` and has no dispatch/cancel/cleanup actions. Run data resides under the **target repository's** Git metadata, so select the same repository that the MCP server is configured to use. It does not change running-task state when reading reports.

The reproducible CLI smoke client is `scripts/smoke.mjs` (only accepts a Git fixture directory named `agent-orchestrator-smoke-*`). Results of a real two-worker planning → coding → testing trial, including discovered permission/cwd fixes, are in `tasks/smoke-report.md`.

The `ask` rules require approval before dispatch/cancel/cleanup. Choose **Allow once** for destructive actions, and keep the approval rules after broader rules because the last matching rule wins. The cleanup tool additionally requires `confirm: true`; ask the user explicitly before supplying it. Tool names appear as `agent-orchestrator_dispatch_tasks` etc. in OpenCode. The MCP server logs nothing on stdout except protocol messages.

## Example task and review

In OpenCode Desktop, request the `agent-orchestrator_dispatch_tasks` tool with:

```json
{
  "tasks": [
    {
      "task_id": "sample-doc",
      "description": "Add a short usage example to docs/usage.md",
      "worker": "opencode",
      "allowed_paths": ["docs/usage.md"],
      "allowed_tests": [["npm", "test"]]
    }
  ]
}
```

Use `get_run_status` with the returned `run_id`; then `collect_run_results` for reports. A zero exit code means only that the CLI exited successfully: inspect `changed_files`, tests and actual diff yourself. For example:

```sh
git -C /path/to/task-worktree status --short
git -C /path/to/task-worktree diff <base_commit>
git -C /path/to/task-worktree ls-files --others --exclude-standard
```

Open a task's reported `worktree_path` in OpenCode or Antigravity Desktop manually for review. `diff_path` points to a diff **stat** (no file contents), while `log_path` records only lifecycle events and test exit codes. Reports and logs live under the target repository's Git common metadata in `agent-orchestrator/runs/<run_id>/<task_id>/`; worktrees under `agent-orchestrator/trees/<run_id>/<task_id>/` there. Reports contain a redacted/truncated worker response. Avoid asking workers to print credentials; sensitive output can never be reliably identified by regex alone.

`cancel_run` stops the run's live workers and retains worktrees. After explicit user approval, call `cleanup_run` with `{ "run_id": "...", "confirm": true }`. Cleanup removes **only clean** worktrees and then their logs if every worktree was removable. Dirty/untracked worktrees remain intact and are reported as `preserved`; branches are always preserved. Inspect or handle those manually. If the server restarts, in-progress tasks are reported as failed/interrupted; inspect their worktrees before redispatch. If the CLI is missing or requires confirmation, run it interactively from the worktree after reviewing its requested permissions; the server does not install or log in for you.

## Boundaries

Input paths must be normalized, relative and inside the Git checkout; existing symlink components are rejected. The worker receives a path/test allowlist as instructions; the orchestrator verifies changed paths **after** the worker exits and executes only the exact allowlisted test argv, without a shell. An agent CLI still has the host user's normal filesystem authority and may launch its own commands: these instructions and post-run checks are **not an OS sandbox**. Set worker CLI permissions separately if strict enforcement is required. This server does not record raw stdout/stderr in logs. Never supply secrets in task descriptions, test argv or allowed paths.

## Checks

```sh
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build
node -e 'JSON.parse(require("node:fs").readFileSync("mcp.example.json", "utf8"))'
```

Tests create throwaway Git repositories with a mock `opencode` binary. They never run a real code-changing worker on your checkout. Desktop connection and Antigravity login/headless behavior require manual confirmation on the target machine.
