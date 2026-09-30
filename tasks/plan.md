# Local CLI worker orchestrator

## Objective

Standalone Node/TypeScript stdio MCP server. OpenCode Desktop dispatches independent tasks to CLI workers in separate worktrees, reviews reports and diffs, and explicitly cleans runs.

## Commands / structure / style

Node >=20, npm; `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`. `src/` contains MCP boundary and Git/process orchestration; `tests/` contains temporary-Git-repository integration tests. Strict TypeScript with NodeNext imports, e.g. `const report = await readReport(runId);`.

## Testing and boundaries

Validate MCP input and repository-relative paths, run bounded processes without shell, persist reports in Git common metadata, never log raw prompts or worker stdout/stderr, do not commit/merge/push. Coordinator may run only exact allowlisted test argv; workers receive restrictions as instructions, not OS confinement. Cleanup removes only clean worktrees, never branches or uncommitted data. Verify via temp repositories and mock worker binaries; no real worker runs against user projects.

## Success

All five MCP tools operate over stdio; isolated worker worktrees and bounded queue; missing/headless-blocked CLIs are task errors; cancellation and recovery are coherent; README supplies OpenCode V2 configuration, approvals, diff review and manual Desktop instructions.
