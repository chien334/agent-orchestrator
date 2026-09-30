# Model selection and end-to-end smoke test

## Goal

Configure a project-local MCP server in this standalone repository, select the verified Muse Spark worker model, and try a planning → coding → testing task in an isolated temporary Git repository. Attempt Antigravity only if its CLI and requested model can be verified locally.

## Steps and verification

1. Add optional model selectors to the task contract and server environment. Verify `opencode run --help`/`agy --help` before passing `--model`; an unsupported flag produces a task error. Tests check argv selection and errors.
2. Add project-local OpenCode V2 MCP configuration with `ask` approval for dispatch/cancel/cleanup. Verify MCP connection with `opencode mcp list` and the stdio protocol test.
3. Create a throwaway Git repository with a failing test for a small specified coding task. Dispatch using the real OpenCode CLI with the verified Muse model; collect status, test results and diff. If CLI authorization/model access blocks, report that limitation without modifying a user project.
4. Run formatter, typecheck, lint, tests and review artifacts. Report Antigravity availability and model resolution separately.

## Boundaries

No software installation or login automation. No auto-merge/commit/push by the coordinator. The throwaway repo only is used for a real worker trial.
