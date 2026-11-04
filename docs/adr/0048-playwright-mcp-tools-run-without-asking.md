# 0048 Every tool of the owner's Playwright MCP entry runs without asking

**Constraint**: Codex asks before each Playwright MCP tool marked `destructiveHint` (18 of
25, `browser_navigate` and `browser_click` among them) on its first call in every thread,
and "Always allow" is saved one tool at a time per Codex account (CODEX§26). A tab that
drives its own Workbench browser stops again and again for questions the owner always
answers yes to.
**Decision**: the owner chose that a Codex tab with the Workbench browser gives each
Playwright MCP entry in the owner's Codex config
`default_tools_approval_mode="approve"`, one server-wide setting that covers every tool,
`browser_run_code_unsafe` included, though it runs any JavaScript in the MCP server's
process outside Codex's sandbox. The butler and scheduled runs get it too, so
there such a call, `browser_run_code_unsafe` included, runs with nobody watching instead
of waiting on a question. An entry where the owner set a server-wide mode of
their own keeps it, and a tool's own `approval_mode` still wins over the server's
(CODEX§26). A remote tab's MCP entries are not touched; the machine's own config decides
there.
**Rejected**: approving only the tools that read a page — the model still stops on its
first click. Approving every tool but `browser_run_code_unsafe` — the owner chose one
setting for the whole server over a list of tool names. Keeping Codex's questions — the reason this was asked for.
