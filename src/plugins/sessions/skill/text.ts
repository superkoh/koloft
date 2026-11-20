import type { TextBlock } from '@core/plugin'
import { OWNER_QUOTE_MARKS } from '@core/ownerWords'
import {
  BACKEND_LABEL,
  SESSION_BACKENDS,
  kindsOf,
  messagingOf,
  namedAtLaunch
} from '@shared/sessionBackend'
import { PICKED_FLAGS } from '../prompts/text'

const EVERY_KIND = kindsOf(SESSION_BACKENDS, 'or')
const ALL_KINDS = kindsOf(SESSION_BACKENDS, 'and')
const KINDS_BUT_CLAUDE = kindsOf(
  SESSION_BACKENDS.filter((b) => b !== 'claude'),
  'or'
)
const KINDS_UNNAMED_REMOTELY = kindsOf(
  SESSION_BACKENDS.filter((b) => !namedAtLaunch(b, true)),
  'or'
)
const KINDS_TYPED_INTO = kindsOf(
  SESSION_BACKENDS.filter((b) =>
    [false, true].some((remote) => messagingOf(b, remote) === 'typed')
  ),
  'or'
)
const UNNAMED_IN_A_REMOTE_WORKSPACE = `${/^[AEIOU]/.test(KINDS_UNNAMED_REMOTELY) ? 'An' : 'A'} ${KINDS_UNNAMED_REMOTELY}`
const BACKEND_CHOICE = SESSION_BACKENDS.join('|')
const OWN_KIND = SESSION_BACKENDS.map((b) => `${BACKEND_LABEL[b]} starts ${BACKEND_LABEL[b]}`).join(
  ', '
)

const SESSIONS = `SESSIONS

A workspace is a folder in Koloft's sidebar. Where a command takes --workspace, give its folder name or its full path; leave it out to mean this session's workspace.

A session's name often has spaces: put it in quotes, like "Fix docs links". If you forget, Koloft still finds it: where a command takes only a name, all the words are the name; where a message or keys come after the name, the name is the first words that make up a session's name. If two sessions' names could both fit, nothing is done and you are asked for the id.

koloft session list [--workspace <workspace>]
    List every session the workspace shows in Koloft's sidebar: first the open ones, with name and state (working, asking the owner a question, finished its turn, or idle), the id of each one you reach with "koloft session send", and the path of its transcript, the file that holds its whole conversation, every turn and tool call, from its first turn on: a file you can read where you run, or machine:path for one only on a machine you reach with ssh; then the rest, closed or asleep, with the machine each runs on, when it was last active and its id. A session started with "koloft session new" says who started it: "started by: you", or the name of the session that did.
    The butler (Koloft's own AI, which the owner talks to in Koloft{{koloft-help-other-ways-to-talk}}) takes no options here and gets every session in every workspace, open or closed: name, ${EVERY_KIND}, the machine it runs on, its state (working, asking the owner a question, finished its turn, idle or closed), when it was last active, its id, its workspace, and who started it.

koloft session read <id or name> [--last <number>]
    Print what was said in a session's last turns (1 if you leave out --last, at most 20): the owner's messages, messages from other sessions, and the session's replies. Works for ${ALL_KINDS} sessions, open or closed.
    Example: koloft session read "Fix docs links" --last 3

koloft workspace list
    List the workspaces in Koloft's sidebar, with each one's path and how many of its sessions are open.

koloft instructions [--workspace <workspace> | --every-workspace]
koloft instructions add [--workspace <workspace> | --every-workspace] -- "<one sentence>"
koloft instructions set [--workspace <workspace> | --every-workspace] -- "<the whole new text>"
    Read the owner's instructions for this workspace (text the owner writes that every session started in it, or in another copy of the same repository, gets last in its prompt), or propose a sentence to add or a whole new text. Propose only when the owner plainly asks you to remember something. Koloft shows the change to the owner in this session's tab and changes nothing until the owner agrees; the command waits for the answer (up to 9 minutes, so give your shell its longest timeout for it) and says whether it was changed. Sessions started afterwards follow the new text; a running session keeps what it started with. Of the workspaces' own, a session reads and changes only its own workspace's.
    The butler: without --workspace these are its own instructions, which it and its helpers follow; with --workspace, that workspace's. A helper of the butler never proposes with --workspace.
    With --every-workspace: the instructions the sessions of every workspace get before their own workspace's; any session may read them and propose a change.
    Example: koloft instructions add -- "Run npm test before you say a change is done."

koloft session new [--name <name>] [--workspace <workspace>] [-w <worktree name>] [--backend ${BACKEND_CHOICE}] ${PICKED_FLAGS} -- "<first message>"
    Pick the model and effort that fit the task, every time. {{koloft-help-pick-model}} A Codex or Antigravity model is named by its family, and Koloft starts the newest version of it the account has; a full model id works too. When the account cannot run the very hard model, or Antigravity's normal one, Koloft starts the next best one and says so.
    Start a sibling session of your own kind (${OWN_KIND}) unless --backend picks another, and print the name to reach it by. The session's name is also the title the owner sees in Koloft{{koloft-help-session-title}}: leave --name out and Koloft makes a short title from the first message, or give a short phrase in the owner's language. It starts in this workspace, on the same machine as you, or in the one --workspace names, which may be on another machine (SSH). ${UNNAMED_IN_A_REMOTE_WORKSPACE} session in a remote workspace has no name. For a ${KINDS_BUT_CLAUDE} session you also get its tab id; its session id shows in "koloft session list" once it starts, and "koloft session send" takes either. -w starts it in a new git worktree of its own (a separate copy of the repository), never in one that already exists: a name already taken gets -2, -3 and so on. The new session is told to report back to you; if it ends its first turn without doing so, Koloft hands its reply to you as a message from it.
    Example: koloft session new --name "Fix docs links" --backend claude --model sonnet --effort low -- "Fix the broken links in docs/."
    Example: koloft session new --workspace koloft --backend codex --model astra --effort high -- "Find why the latest release is missing files."
    The butler: without --workspace the session starts in the butler's own folder, shown under the butler in the sidebar, for any task that belongs to no project; it is told the butler's goals and to report back. With --workspace it starts in that project's workspace like any other session; in a git workspace it always gets its own worktree: -w names it, and without -w Koloft picks a name.

How to talk to a session you started:
    Claude to Claude on the same machine: use your SendMessage tool with its name. ListAgents shows the sessions on this machine; SendMessage cannot reach one on another machine, so use "koloft session send" for that.
    Any other pair (a ${KINDS_BUT_CLAUDE} session, or a Claude session talking to one): use "koloft session send".
    The butler: use "koloft session send" for every session, ${EVERY_KIND}.

koloft session send <id or name> "<message>"
    Send a message to any session in any workspace: ${EVERY_KIND}, except from one open Claude session to another on the same machine, which uses SendMessage. A closed one is resumed first, and a ${KINDS_TYPED_INTO} session, which Koloft types into, only gets it once its turn has ended; then you are told "Will deliver when … is ready." at once, and if it never gets there you hear "[Koloft] Could not deliver to …" later.
    The butler: your message reaches the session marked as coming from you, for the owner: only words you put inside ${OWNER_QUOTE_MARKS} count as the owner's own. If the session is asking the owner a question, the answer says so: it reads your message only once that is answered. When it ends the turn that follows your message, Koloft hands you its reply, unless it reported to you itself.
    Any session: report back to the session or the butler that started you, with the id it gave you. If it is not running, Koloft starts it again first.
    Example: koloft session send 0199c3f2-7a41-7c30-9e55-1d2b8f6a0c11 "Tell me what you found."

koloft session command <id or name | me> /<command> [arguments]
    Run one slash command (like /compact, /clear or /context) in any session, or in yourself with "me". Koloft waits until that session is idle with no question showing, types the command, and hands you what it printed as a message from Koloft{{koloft-help-command-output}} command line itself only tells you it was handed over. After /clear (or /new in Codex) the session gets a new id: reach it by its name, or run koloft session list again. A command that opens a menu is closed with Esc, so give the command its arguments (like /model haiku).
    Example: koloft session command fix-login /compact keep the test plan

koloft session screen <id or name | me>
    Print what an open session's terminal shows right now: a question, a menu, a list of options, an error. Use it to see what a session is waiting on, or when the owner asks what a command showed that Koloft could only see on the screen.
    Example: koloft session screen "Fix docs links"

koloft session keys <id or name> <key>...
    Press keys in an open session, in order, as the owner would at the Mac. With screen, this lets you do anything the owner could do in that session: pick an option, answer every part of a question with several parts, move through a menu, approve, refuse or cancel. Key names: Enter, Esc, Tab, Shift-Tab, Up, Down, Left, Right, Space, Backspace. Any other word is typed as it is; put text with spaces in quotes. After pressing keys, run screen to see what changed.
    Example: koloft session keys fix-login 2
    Example: koloft session keys fix-login Down Down Enter
    Example: koloft session keys fix-login 3 "use the blue one" Enter

koloft session answer <id or name> <option number | yes | no | your own words>
    Answer the question or approval a session is showing right now. A number picks that option; yes or no approves or refuses; other words are the answer itself (for an approval or a plan: what to do instead). A question of several parts takes one line per part, all in one quoted argument (in a shell: "$(printf '2\\n1, 3')"), and a part that takes several options takes their numbers split by commas. Only answer the way the owner told you. If it is refused while the session is still waiting, run screen and answer with keys.
    Example: koloft session answer "Fix docs links" 2

koloft session resume <id or name> [-- "<message>"]
    Resume a closed session, and if you like send it a first message.
    Example: koloft session resume "Fix docs links" -- "Carry on with the tests."

koloft session stop <id or name>
    Close a session's tab. The session stays in the list and can be resumed.
    Example: koloft session stop "Fix docs links"

koloft session close [<id or name>]
    Close a session for good: Koloft ends it, closes its tab and takes it off the sidebar list. If it runs in its own git worktree, Koloft also deletes that worktree and its branches. With no id or name it closes the session you run it in; run that as your very last step, only when the owner asked for it. With an id or name it closes a session started with "koloft session new" by you, or by a session you started, and so on down (open, or already ended), once you have its result; or, when the owner asks, any other session on this computer, open or ended (an open one is ended first, so do not stop it yourself): one on another machine is refused. Do not resume a session to ask it to close itself. If anything in the worktree is not committed, or a commit is on no other branch and no remote branch, nothing is closed and Koloft lists what is left. Koloft has no merge button: to bring a worktree session's work into the main checkout, commit it in the worktree, merge its branch in the main checkout, then close. From inside the worktree, git aimed at the main checkout may be refused (Claude Code refuses it, and a ! command too): then start a session in the main checkout with koloft session new ${PICKED_FLAGS} -- "<task>" (from a worktree session, without -w it starts there), ask it to merge the branch, and close it once it reports the merge done.
    Example: koloft session close "Fix docs links"`

// CC§3 CODEX§12 MUSE§8 AGY§25
const KOLOFT_HELP = `koloft lets you ask Koloft, the app this session runs in, to do things for its owner (the person you work for). Run it in your shell. Each command prints its answer; exit code 0 means it worked.

RULES

1. Once you start a session, keep it under your control: remember its name, and give it work and collect its results by messaging it. When you no longer need it, tell the owner.{{koloft-help-rule-open}}{{koloft-help-rule-cron}}{{koloft-help-rule-note}}{{koloft-help-workbench}}{{koloft-help-cron}}

${SESSIONS}{{koloft-help-inbox}}{{koloft-help-todo}}{{koloft-help-passwords}}{{koloft-help-chat}}{{koloft-help-github}}{{koloft-help-web-pages}}{{koloft-help-remote-web-tabs}}`

const KOLOFT_SKILL =
  "Use the koloft command to ask Koloft, the app this session runs in, to {{koloft-skill-workbench}}{{koloft-skill-cron}}list, start, message, run slash commands in, see the screen of, press keys in, answer, resume and stop sessions, read what a session said, close this session and its worktree for good, read or change the owner's instructions for this workspace{{koloft-skill-or-list}}.{{koloft-skill-web-pages}} Read this before running any koloft{{koloft-skill-web-pages-command}} command."

export const TEXT: readonly TextBlock[] = [
  { slot: 'koloft-help', text: KOLOFT_HELP },
  {
    slot: 'koloft-help-command',
    text: `koloft help
    Show this guide.

`
  },
  { slot: 'koloft-help-command-output', whenOff: 'discord', text: '. The' },
  { slot: 'koloft-skill', text: KOLOFT_SKILL }
]
