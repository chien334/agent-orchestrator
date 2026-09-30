# Local run dashboard

## Objective

Show task/worker/model/status/elapsed/test/worktree/log for runs created by the MCP server in a read-only, local browser page.

## Design

- Node HTTP process bound to 127.0.0.1 with `GET /api/runs` and one static page. No added runtime dependencies.
- A read-only snapshot method reads reports from Git common metadata without changing interrupted/running state. Cap returned run count and omit final worker response and test error output from the browser API.
- Accessible responsive table/list with status labels, details, refresh and automatic polling; render server data with text nodes only.

## Verification

- Temporary-Git-repository integration test for empty/list/error/snapshot non-mutation and HTTP response.
- Build, lint, typecheck, formatter and existing tests; inspect empty and populated views at desktop and mobile widths in a real browser, check console and network.

## Files

`src/orchestrator.ts`, `src/dashboard.ts`, `public/index.html`, `tests/dashboard.test.ts`, `package.json`, `README.md`.
