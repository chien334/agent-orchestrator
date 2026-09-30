# End-to-end MCP smoke test — 2026-09-30

## Setup and acceptance

- Tested with OpenCode CLI `2.0.20`, Antigravity CLI `1.2.14`, Node `22.22.2`, on macOS arm64.
- `opencode mcp list` from this project: `agent-orchestrator connected`.
- Verified model IDs: `opencode/muse-spark-1.3-contributor-free` (catalog and live `READY` reply); `gemini-3.8-flash-high` (`agy models` and live `READY` reply).
- Temporary Git fixture: `/private/var/folders/lp/v553fw757t90pqn2z0w221g40000gn/T/opencode/agent-orchestrator-smoke-CR8ujt` at commit `6d0bf315`. Both fixture tests failed before dispatch (RED).

## Planning → coding → testing

| MCP run / task                                          | Worker                | Outcome   | Change                                                                                        | Coordinator-run test                             |
| ------------------------------------------------------- | --------------------- | --------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `25c29088-fdf7-4385-8345-e06b41130de7 / muse-normalize` | Muse Spark 1.3 free   | completed | `src/normalize.mjs`: trim, then collapse consecutive whitespace to one space                  | `node --test tests/normalize.test.mjs`: 1 passed |
| `de023b94-561d-4cf2-bdce-aadb1d99479e / gemini-slug`    | Gemini 3.8 Flash High | completed | `src/slug.mjs`: lower-case, replace `đ`, remove combining marks, turn separators into hyphens | `node --test tests/slug.test.mjs`: 1 passed      |

Both worker responses included a plan before code. Reviewed `git diff` in both worktrees: each changed only its allowlisted source file. The fixture working tree was not modified. No changes from these worktrees were merged or committed.

## Failures found and resolved

- Initial OpenCode run exited 0 but read the orchestrator checkout, not its task worktree: inherited `PWD` overrode the spawned process's `cwd`. Corrected the child environment and selected `--standalone`. Regression test checks `PWD === process.cwd()`.
- Initial Antigravity run exited 0 with `denied_actions` for file edit; `--mode accept-edits` allowed worktree edits. A later attempt denied a command tool, so the Antigravity worker is now instructed to edit using file tools only and the coordinator runs the allowlisted test. JSON `denied_actions` (including output preceded by CLI diagnostics) is classified as `blocked` instead of completed. Regression test covers this case.

These trials used the MCP stdio protocol through an SDK client with `dispatch_tasks`, `get_run_status`, and `collect_run_results`; no real code-changing worker was run on the project repository. OpenCode Desktop UI approval prompts were not exercised.
