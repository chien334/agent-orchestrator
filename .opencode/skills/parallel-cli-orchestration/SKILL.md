---
name: parallel-cli-orchestration
description: Delegate independent coding tasks to OpenCode CLI and Antigravity CLI through the local agent-orchestrator MCP server, monitor runs, review worktree diffs and tests, and report outcomes. Use when the user asks to run multiple agents or track which CLI is working.
---

# Parallel CLI Orchestration

Use the five tools from the `agent-orchestrator` MCP server. A visual explanation for people is in [`../../../docs/orchestration-flow.html`](../../../docs/orchestration-flow.html). Read the project's `README.md` for installation/configuration details.

## 1. Prepare and plan

1. Verify the target directory is a Git repository with a `HEAD` commit. Worktrees start from that commit; uncommitted changes in the main checkout are **not** carried over.
2. Confirm `opencode mcp list` reports `agent-orchestrator connected`. The MCP server must use the **target repository** as its `cwd`; the dashboard must point to that same repository.
3. Break the request into independent, reviewable tasks. Give each a unique `task_id`, a clear description/acceptance criterion, one `worker` (`opencode` or `agy`), repository-relative `allowed_paths`, and exact `allowed_tests` argv arrays. Avoid overlapping allowed paths when tasks run concurrently. Do not put secrets in descriptions or argv.
4. Use the verified model IDs when needed: `opencode/muse-spark-1.3-contributor-free` and `gemini-3.8-flash-high`. A per-task `model` overrides the MCP server's environment default. If a requested model is unavailable, report the CLI error rather than silently switching models.
5. Briefly tell the user which task goes to which CLI and which files/tests each may touch before dispatching. Respect OpenCode's approval prompt for the dispatch tool.

## 2. Dispatch

Call `agent-orchestrator_dispatch_tasks` (under Code Mode, use the catalog's exact tool path, with bracket notation for the hyphenated server name) with validated tasks. Example:

```json
{
  "tasks": [
    {
      "task_id": "docs-example",
      "description": "Add a short usage example to docs/usage.md; report what changed.",
      "worker": "opencode",
      "allowed_paths": ["docs/usage.md"],
      "allowed_tests": [["npm", "test"]]
    },
    {
      "task_id": "readme-check",
      "description": "Clarify setup steps in README.md; report what changed.",
      "worker": "agy",
      "allowed_paths": ["README.md"],
      "allowed_tests": [["npm", "run", "typecheck"]]
    }
  ]
}
```

Record the returned `run_id`. Each task has a separate branch and worktree; the server limits concurrent workers (default 3). Do not assume exit code 0 means correct code.

## 3. Monitor

- Call `agent-orchestrator_get_run_status` with `{ "run_id": "..." }`. Report `task_id`, `worker`, `model`, `status`, elapsed time, and `worktree_path` to the user. Statuses: `queued`, `running`, `completed`, `failed`, `blocked`, `cancelled`.
- The read-only dashboard (`npm run dashboard`, `http://127.0.0.1:4317`) shows recent runs, tests, and paths. For another repo, set `ORCHESTRATOR_REPO_ROOT=/absolute/path/to/repo`. The dashboard must not be used to change run state.
- Poll at reasonable intervals; do not block indefinitely. If the CLI is missing, not signed in, or requests headless approval, surface the task's error/`blocked` status and worktree path. Do not install, sign in, or use blanket permission-skip flags without a separate user request.

## 4. Review and report

Call `agent-orchestrator_collect_run_results` using the `run_id`. For every task, read the summary, exit code, changed files, tests, errors, and paths. Inspect the **actual** diff in its worktree:

```sh
git -C /path/to/worktree status --short
git -C /path/to/worktree diff <base_commit>
git -C /path/to/worktree ls-files --others --exclude-standard
```

Check file scope, unexpected edits, and test results. The `diff_path` is a diff **stat**, not the patch. The allowed-path/test instructions to workers are not OS-level isolation; inspect results critically. Summarize each CLI separately and distinguish worker claims from verified tests/diff. Never merge, cherry-pick, commit, or push on the worker's behalf.

## 5. Stop and clean only when requested

- Use `agent-orchestrator_cancel_run` to stop a run if the user requests cancellation. It preserves branches and worktrees.
- Call `agent-orchestrator_cleanup_run` **only after an explicit user request**, with `{ "run_id": "...", "confirm": true }`. Dirty worktrees and all branches are preserved. State clearly which paths were removed or preserved.
