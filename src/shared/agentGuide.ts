import { GLOBAL_SCOPE } from './conductors'
import { parseRemoteKey, remoteCopyText } from './remoteKey'

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
Options: --backend claude|codex, --model <model>, --effort low|medium|high|xhigh|max, --permission same|acceptEdits|skipAll, --when-done open|close
    same: the same permission as a session started from the sidebar's + button.
    acceptEdits: may change files without asking.
    skipAll: never asks for permission.
    --when-done close: the run's tab closes once it finishes its work, so the next run is not skipped. The default, open, leaves it open for you.

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

A workspace is a folder in Koloft's sidebar. Where a command takes --workspace, give its folder name or its full path; leave it out to mean this session's workspace.

koloft session list [--workspace <workspace>]
    List a workspace's sessions: name and state (working, waiting for the owner, or idle). For a Claude session it also prints the path of its transcript (the file that holds its conversation).
    A conductor (the session the owner talks to through Discord) takes no options here and gets every session it looks after, open or closed: name, Claude or Codex, the machine it runs on, its state (working, waiting for the owner, idle or closed), when it was last active, and its id. The global conductor also gets each session's workspace.

koloft session read <id or name> [--last <number>]
    Print what was said in a session's last turns (1 if you leave out --last, at most 20): the owner's messages, messages from other sessions, and the session's replies. Works for Claude and Codex sessions, open or closed.
    Example: koloft session read fix-login --last 3

koloft workspace list
    Only for the global conductor: list the workspaces in Koloft's sidebar, with each one's path and how many of its sessions are open.

koloft session new [--name <name>] [--workspace <workspace>] [-w <worktree name>] [--model <model>] -- "<first message>"
    Start a sibling session of your own kind (Claude starts Claude, Codex starts Codex), and print the name to reach it by. It starts in this workspace, or in the one --workspace names; a remote (SSH) workspace is not allowed. A Codex session has no name, so you get its tab id instead; its session id shows in "koloft session list" once it starts, and "koloft session send" takes either. -w starts it in its own git worktree (a separate copy of the repository).
    Example: koloft session new --name docs-fixer -- "Fix the broken links in docs/."
    Example: koloft session new --workspace koloft-releases -- "Check that the latest release has all its files."
    A conductor may also pick --backend claude|codex (its own kind if left out). The global conductor must give --workspace; a workspace conductor can only start sessions in its own workspace. The new session is told to report back to the conductor.

How to talk to a session you started:
    Claude: use your SendMessage tool with its name. ListAgents shows the sessions on this machine.
    Codex: use "koloft session send".
    A conductor: use "koloft session send" for every session, Claude or Codex.

koloft session send <id or name> "<message>"
    Codex: send a message to another Codex session.
    A conductor: send a message to any session it looks after. Your message reaches it marked as coming from the owner through you. A closed one is resumed first, and a session on another machine only gets it once its turn has ended; then you are told "Will deliver when … is ready." at once, and if it never gets there you hear "[Koloft] Could not deliver to …" later.
    Any session: report back to the conductor that started you, with the id it gave you.
    Example: koloft session send 0199c3f2-7a41-7c30-9e55-1d2b8f6a0c11 "Tell me what you found."

koloft session answer <id or name> <option number | yes | no | your own words>
    Only for a conductor: answer the question or approval a session it looks after is showing right now, the one Koloft posted in Discord as "… is waiting for you". A number picks that option; yes or no approves or refuses; other words are the answer itself (for an approval or a plan: what to do instead). Only answer the way the owner told you.
    Example: koloft session answer fix-login 2

koloft session resume <id or name> [-- "<message>"]
    Only for a conductor: resume a closed session it looks after, and if you like send it a first message.
    Example: koloft session resume fix-login -- "Carry on with the tests."

koloft session stop <id or name>
    Only for a conductor: close a session's tab. The session stays in the list and can be resumed.
    Example: koloft session stop fix-login

koloft session close [<id or name>]
    Close a session for good: Koloft ends it, closes its tab and takes it off the sidebar list. If it runs in its own git worktree, Koloft also deletes that worktree and its branches. With no id or name it closes the session you run it in; run that as your very last step, only when the owner asked for it. With an id or name it closes a session you started with "koloft session new" (open, or already ended), once you have its result. If anything in the worktree is not committed, or a commit is on no remote branch, nothing is closed and Koloft lists what is left.
    Example: koloft session close docs-fixer

DISCORD (conductors only)

koloft discord send <file>... [-- "<text>"]
    Only for a conductor: send files, pictures or screenshots to the Discord channel the owner talks to you in, with an optional line of text. Paths are relative to your current folder. At most 20 MB per file. Use it when the owner wants to see a file or a screenshot; a path you only mention in your reply is not sent.
    Example: koloft discord send shot.png -- "The login page now."

WEB PAGES (Claude only)

To use the web pages in this session's Workbench, drive them with Playwright (a tool that controls a browser): the playwright-cli command or the Playwright MCP tools. When the owner allows it, they already connect to the Workbench browser; its address is in $KOLOFT_BROWSER_CDP. Codex sessions cannot do this.`

export const AGENT_SKILL_DESCRIPTION =
  'Use the koloft command to ask Koloft, the app this session runs in, to show a file, web page or git diff in the Workbench, read or add to the workspace note, list, add, change or run scheduled tasks, list, start, message, answer, resume and stop sessions, read what a session said, or close this session and its worktree for good. Read this before running any koloft command.'

export function conductorRole(scope: string): string {
  const remote = parseRemoteKey(scope)
  const what =
    scope === GLOBAL_SCOPE
      ? 'all workspaces'
      : `the workspace ${remote ? remoteCopyText(remote.host, remote.path) : scope}`
  return `You are Koloft's conductor for ${what}. Messages starting with [Discord] come from the owner via Discord. Use the koloft command (koloft help) to look after the sessions in your scope: koloft session list, read, new (with --backend claude|codex${scope === GLOBAL_SCOPE ? ' and --workspace' : ''}), send, answer, resume and stop. Message every session with koloft session send, whether it is Claude or Codex. Koloft tells the owner in Discord when a session you started or messaged finishes, waits for an answer or closes, so do not repeat that; when the owner tells you how to answer a waiting session, run koloft session answer. Your replies reach the owner in Discord; when the owner wants to see a file or a screenshot, send it with koloft discord send <file>.`
}

export const CODEX_AGENT_HINT =
  'You are running inside Koloft, an app that runs and manages coding sessions for its owner. Run "koloft help" in your shell to see what Koloft lets you do.'
