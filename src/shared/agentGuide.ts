export const AGENT_GUIDE = `koloft lets you ask Koloft, the app this session runs in, to do things for its owner (the person you work for). Run it in your shell. Each command prints its answer; exit code 0 means it worked.

RULES

1. For normal work, use your own subagents, teammates or workflows, not "koloft session new". Those helpers stay under your control and give their results back to you.
2. Use "koloft session new" only when the owner clearly wants a separate session they can see in Koloft and take over, for example "start another session to do X".
3. Once you start a session, keep it under your control: remember its name, and give it work and collect its results by messaging it. When you no longer need it, tell the owner.
4. Use "open" and "diff" only when the owner wants to look at something, or when you hand a result to the owner. Do not open every file you write.
5. Scheduled tasks: before you add or change one, tell the owner how often it runs, what it does and which permission it gets. Before you remove one, run "koloft cron show" to be sure it is the right one.
6. Only use "note append" for things later sessions will really need.

WORKBENCH AND NOTE

The Workbench is this session's side panel in Koloft. The note is one plain-text note that every session in this workspace shares.

koloft help
    Show this guide.

koloft open <file or web address>
    Show a file or a web page in this session's Workbench.
    Example: koloft open docs/plan.md

koloft diff <file>
    Show the file's git changes (what changed since the last commit) in the Workbench.
    Example: koloft diff src/app.ts

koloft note
    Print the workspace note.

koloft note append <text>
    Add text to the end of the workspace note.
    Example: koloft note append "Run npm run rebuild after changing the Electron version."

SCHEDULED TASKS

A scheduled task (cron) is a job that starts a new session by itself on a timer. Name a task by its number from "koloft cron list" or by its name.

When it runs: --every 30m, --every 2h, --daily 09:00, or --weekly mon,wed,fri@09:00
Options: --backend claude|codex, --model <model>, --effort low|medium|high|xhigh|max, --permission same|acceptEdits|skipAll
    same: the same permission as a session started from the sidebar's + button.
    acceptEdits: may change files without asking.
    skipAll: never asks for permission.

koloft cron list
    List this workspace's tasks: number, name, when it runs, on or off, next run, last result.

koloft cron show <number or name>
    Show one task in full: what it does, model, permission, recent runs.
    Example: koloft cron show 2

koloft cron add --name <name> <when it runs> [options] -- "<what to do>"
    Add a task.
    Example: koloft cron add --name nightly-tests --daily 02:00 --permission acceptEdits -- "Run the tests and write a short report."

koloft cron edit <number or name> [when it runs] [options] [-- "<what to do>"]
    Change a task. Only the parts you give change.
    Example: koloft cron edit nightly-tests --daily 03:00

koloft cron rm <number or name>
    Remove a task.
    Example: koloft cron rm nightly-tests

koloft cron on <number or name>
koloft cron off <number or name>
    Turn a task on or off.
    Example: koloft cron off 2

koloft cron run <number or name>
    Run a task once, right now.
    Example: koloft cron run nightly-tests

SESSIONS

koloft session list
    List this workspace's sessions: name and state (working, waiting for the owner, or idle). For a Claude session it also prints the path of its transcript (the file that holds its conversation).

koloft session new [--name <name>] [-w <worktree name>] [--model <model>] -- "<first message>"
    Start a sibling session of your own kind (Claude starts Claude, Codex starts Codex) in this workspace, and print the name to reach it by. A Codex session has no name, so you get its tab id instead; its session id shows in "koloft session list" once it starts, and "koloft session send" takes either. -w starts it in its own git worktree (a separate copy of the repository).
    Example: koloft session new --name docs-fixer -- "Fix the broken links in docs/."

How to talk to a session you started:
    Claude: use your SendMessage tool with its name. ListAgents shows the sessions on this machine.
    Codex: use "koloft session send".

koloft session send <id or name> "<message>"
    Codex only: send a message to another Codex session.
    Example: koloft session send 0199c3f2-7a41-7c30-9e55-1d2b8f6a0c11 "Tell me what you found."

WEB PAGES (Claude only)

To use the web pages in this session's Workbench, drive them with Playwright (a tool that controls a browser): the playwright-cli command or the Playwright MCP tools. When the owner allows it, they already connect to the Workbench browser; its address is in $KOLOFT_BROWSER_CDP. Codex sessions cannot do this yet.`

export const AGENT_SKILL_DESCRIPTION =
  'Use the koloft command to ask Koloft, the app this session runs in, to show a file, web page or git diff in the Workbench, read or add to the workspace note, list, add, change or run scheduled tasks, or list and start sibling sessions. Read this before running any koloft command.'

export const CODEX_AGENT_HINT =
  'You are running inside Koloft, an app that runs and manages coding sessions for its owner. Run "koloft help" in your shell to see what Koloft lets you do.'
