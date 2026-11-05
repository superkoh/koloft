# 0048 Every tool of the owner's Playwright MCP entry runs without asking

**Constraint**: Codex asks before each Playwright MCP tool marked `destructiveHint` (18 of
25, `browser_navigate` and `browser_click` among them) on its first call in every thread,
and "Always allow" is saved one tool at a time per Codex account (CODEX§26). Antigravity
asks before every MCP tool call, read-only ones too, and its "always allow" is saved one
tool at a time too (AGY§26). Muse asks before every call of a tool not marked read-only,
saves "always allow" one tool at a time, and has no rule that covers a whole server
(MUSE§21). Claude Code asks before every MCP tool call, read-only ones too, and its
"don't ask again" is saved one tool at a time per folder (CC§24). A tab that drives its own Workbench browser stops again and
again for questions the owner always answers yes to.
**Decision**: the owner chose that a Codex tab with the Workbench browser gives each
Playwright MCP entry in the owner's Codex config
`default_tools_approval_mode="approve"`, one server-wide setting that covers every tool,
`browser_run_code_unsafe` included, though it runs any JavaScript in the MCP server's
process outside Codex's sandbox. A local Antigravity tab with the Workbench browser gets
the same through the allow rule `mcp(<server>/*)` in its account folder's settings, for
each Playwright entry in the owner's `~/.gemini/config/mcp_config.json`. A local Muse tab
with the Workbench browser gets one `tool_action` allow rule per Playwright tool that is
not read-only, by name, in its account folder's `approval-policy.json`, for each
Playwright entry in the owner's `~/.config/muse/settings.json`; a tool name any other
rule there names gets none, and only rules carrying Koloft's `reason` are taken back. For
the server to reach the Workbench browser at all, that
account folder's `settings.json` is Koloft's copy of the owner's, whose Playwright
entries always carry `"${PLAYWRIGHT_MCP_CDP_ENDPOINT}"` in their `env` (MUSE§21), and
every muse Koloft starts on that folder has the variable set, empty when there is no
Workbench browser, since an unset one stops the server. Those lines never reach the
owner's own file, so a muse run outside Koloft keeps working. Each setting Muse itself
changes in the copy from inside a Koloft tab (`/theme`, `/permissions`) is copied back
into the owner's file, without Koloft's lines, at the next launch, against the copy
Koloft last wrote; settings the owner changed meanwhile are kept. The butler and
scheduled runs get it too, so
there such a call, `browser_run_code_unsafe` included, runs with nobody watching instead
of waiting on a question. A local Claude tab with the Workbench browser gets the allow
rule `mcp__<server>` in Koloft's own `--settings` file, for each Playwright entry its
folder reaches (`~/.claude.json`, that folder's project there, `.mcp.json` above it),
judged by the entry Claude Code runs under that name; nothing is written into the
owner's files, and an owner's own `deny` or `ask` rule for the server or a tool, in user,
project or local settings, still wins (CC§24), so Koloft does not look for one. An entry where the owner set a server-wide mode of
their own keeps it, and a tool's own `approval_mode` still wins over the server's
(CODEX§26); an Antigravity entry the owner's own `permissions` name in any rule gets no
rule from Koloft. A remote tab's MCP entries are not touched; the machine's own config
decides there.
**Rejected**: approving only the tools that read a page — the model still stops on its
first click. Approving every tool but `browser_run_code_unsafe` — the owner chose one
setting for the whole server over a list of tool names. Keeping Codex's questions — the reason this was asked for.
For Muse, writing the `${…}` lines into the owner's own `settings.json` — an unset
`${VAR}` stops the server from starting (MUSE§21), so the owner's Playwright MCP would
stop working in a muse run outside Koloft. Writing the lines only while the tab has the
Workbench browser — the copy is shared by every tab of the account, so the tab launched
last would add or strip them under the others.
