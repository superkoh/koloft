# Roadmap

What Koloft is going to do next, what it is deliberately not going to do, and how much to
trust the ordering. Kept as a document rather than an issue so it can be read in one
place and edited in one place.

## The idea everything is judged against

1. You declare a **workspace** and create or resume **Claude Code or Codex sessions** in
   it. Koloft orchestrates; it does not spectate.
2. A free-floating terminal is **not** a product goal. A shell exists only as a session's
   helper tool, inside that session's Workbench, and never hosts an agent's TUI of its own.
3. The centre of the window is **100% the session's own tool UI** — Claude Code's or
   Codex's — with no Koloft chrome inside it.
4. Worktree lifecycle and session retention belong to **the agent's tool**, not Koloft.
   Three gaps, all run on the owner's word: Koloft makes the worktree for a Codex
   worktree session, and removes it when its Codex ends (not when the tab sleeps or
   restarts, or Koloft quits) only if nothing was done in it —
   no other session in it, still on `worktree-<name>` at the commit it was made from,
   and no changed, new or ignored file except unchanged copies from the main checkout —
   the way `claude -w` removes an unchanged one; any other is kept until
   `koloft session close` removes it (#116); Koloft makes the
   `pr-<n>` worktree for a session started from a pull request, on that pull request's
   own branch, because `claude -w` only makes a worktree on a new `worktree-<name>`
   branch (#218); and a conductor may `koloft session close` an ended local session in
   its scope (#337), relaying what the owner said — Koloft never decides on its own that
   a session goes.
5. A file opens in the Workbench **on your intent only** — nothing follows the agent's
   writes around by itself.

A request that pulls against one of these is closed even when it is a good idea, and even
when it works. That is what "judged against" means.

## Planned

### Tier 1 — orchestration: the session is the unit

- **Jump to the next waiting session** — one shortcut cycles through the sessions waiting
  for you, across workspaces (#216). A grouped sidebar view is not part of it.
- **Broadcast input** — type once, send to the sessions you selected. The workspace →
  session tree is the first reliable "select N sessions" unit Koloft has had, so the
  scope is unambiguous: the rows you picked, nothing implied.
- **Agents use Koloft themselves** — a Claude or Codex session in Koloft already has a
  `koloft` command and a guide for it: scheduled tasks, opening a file, page or diff in
  its Workbench, the workspace note, and starting a sibling session and talking to it.
  A conductor (a session bound to a Discord channel) also reads what a session said,
  and sends to, resumes, stops and starts any session in its scope, Claude or Codex,
  and closes an ended one on this computer. It only passes work on (ADR-0029), but checks
  facts on GitHub itself with `koloft gh`, which reads and, when the owner asks, opens an
  issue, and a Claude conductor keeps its own memory.
  A Claude session on another machine over ssh has the same command; its answers take
  a few seconds longer.

### Tier 2 — review: where Koloft can still grow

- **Jump to the turn behind a hunk** — from a hunk in the Changes view to the agent turn
  that produced it.
- **Point the agent at things** — pick an element in the Workbench browser (#217).
- **Many sessions, one change** — warn when two sessions write the same file (#221); each
  session's listening ports, opened in the Workbench browser (#224).
- **Branching sessions** — fork a session from the sidebar (#219).
- **Usage and accounts** — cost history by session, workspace, model and day (#225); pick
  or pin a custom-endpoint account for a session (#226).

### Parked until their trigger

- **OpenCode as a third backend** (#227) — after the items above.
- **Sessions that survive quit and update** (#228) — when an update interrupting a working
  session shows up as a real complaint.
- **Windows, Linux and Intel Mac builds** (#229) — when user demand shows up.

### Tier 3 — guardrails

- **Measure-first performance backlog** — the file watcher, cold start, a Zustand audit,
  pty-host isolation. Each carries the symptom that would justify it; none is scheduled
  on a hunch.
- **Changes stream memory** — every diff block lives in the DOM and the count is
  unbounded. Measure before folding.
- **PDF previews outside the guest budget** — one PDFium process per changed PDF, not
  counted against the 12-guest cap.

## Deliberately not doing

Reopen one of these only with new evidence, not a new argument.

- **An agent typing into another session's terminal** — agents in Koloft start and steer
  a sibling session through messages (Claude Code's own `SendMessage`, and
  `koloft session send` for Codex), which the receiving session sees as a message it can
  judge. Faked keystrokes land in whatever that TUI's input box holds at the time.
  Broadcast input above is a feature for the *person*, with the rows they picked.
  Three exceptions, all the owner's decisions. First, a conductor's `koloft session send`
  to a Claude session on another machine over ssh is typed into its terminal, because
  that session's message socket is on the other machine where Koloft cannot reach it.
  Koloft types only when that session's turn has ended and it shows no dialog; its state
  arrives a mirror pull late, so a message can still land in a turn that just began,
  where Claude queues it. Second, a conductor's `koloft session command` types a slash
  command, because a message delivers `/compact` as plain text (CC§12, CODEX§21); Koloft
  types it only when that session is idle with no question or menu showing. Third, a
  conductor's `koloft session keys` presses keys in a session (CC§12, CODEX§25).

- **A one-click Review button that starts a sibling to review the diff** (#222) — a
  session already starts its own sibling session or subagent to review its changes
  when asked.
- **Checkpoints / rewind** — native in Claude Code (`/rewind`). At most, surface the list.
- **Split panes / tiled layouts** — high cost on xterm.js for a window whose centre is
  one TUI.
- **`<webview>` → `WebContentsView`, node-pty → a Rust pty** — rejected in the
  measure-first backlog: no observed symptom.
- **Shell command-block navigation** — its subject is a *shell* session, but the centre
  is always the agent's TUI (alt-screen, no prompt marks), and the only shell left is the
  helper tab, which never hosts an agent. The surviving requirement — jump between
  agent turns — moved to Tier 2.
- **A quake-style hotkey window** — the value it was for already ships: clicking the OS
  notification brings the window forward with that session active. And hide-on-blur
  contradicts a board you keep visible.
- **More preview renderers (CSV and the like)** — Markdown, code, images and PDF cover
  nearly every file a session produces; any other format opens in the app the system
  already has for it.
- **pty → utilityProcess** — no observed jank. Folded into the performance backlog with
  the trigger that would justify it.
- **Undo-close tab** — a closed session stays in the list as a cold row with *Resume*,
  and closing a working or approval-pending session asks first. There is nothing left to
  undo.
- **Auto-archive a session when its PR merges** — retention belongs to the agent's tool
  (idea 4), and a closed session is meant to stay listed as a cold row.
- **A grouped "waiting / working / ready" sidebar view** — the sidebar carries no roll-up
  (pinned by `attention-outlets.spec.ts`); the jump shortcut in Tier 1 answers the same
  need.
- **Kanban or task boards** — pulls Koloft toward a project tracker; the session tree is
  the board.
- **Per-session sandboxing (Seatbelt, Docker)** — the tools ship their own sandboxes.
- **One session across several repos** — breaks "one workspace, one tree".
- **Shared or multiplayer sessions** — a local app with no server.
- **A chat UI instead of, or beside, the terminal** — against "the centre is 100% the
  tool's own UI".
- **Cloud agents** — no cloud service; running elsewhere is what ssh workspaces are for.
- **Voice input** — macOS dictation already reaches the terminal.
- **Approve or deny from Koloft's own UI** — answering for the TUI from outside is
  keystroke-faking by another name; the prompt is answered where it appears.
- **A separate Plan view** (#8) — a Claude plan is a file that already opens from the
  Workbench Docs row, and both tools show the plan in the terminal.
- **Desktop pets, theme stores, Office previews** — decoration, or another previewer.

## How much to trust the order

Koloft has **no usage data of its own**. The ordering rests on consistency with the idea
above (hard, documented), on what comparable tools' users asked for (soft, not
re-verified), and on the author's own felt experience (unrecorded). That is not enough to
schedule against. The cheapest missing research is ten recorded real uses — what Koloft
was opened to do, where it stalled, whether a bare terminal got used instead. Ten entries
would settle Tier 1 against Tier 2.

## Strategy notes

- **Augment the real CLI in a real terminal; don't replace it.** The dominant complaint
  against GUI wrappers is losing the real thing — aliases, `PATH`, editor integration.
  The terminal that must never be buried is the one the *agent* lives in: the Claude or
  Codex TUI, which is why it has the whole centre. That is not the same as keeping a
  free-floating shell, which is a non-goal.
- **Anti-patterns with a track record of backlash**: telemetry, forced login, hiding the
  terminal, auto-hide-on-blur without an opt-out, ambiguous broadcast scope. Koloft has
  none of the first three and will not add them. The one sign-in it does ask for is a
  Claude or Codex account added in Settings ▸ Accounts, which every session runs on
  (ADR-0030) — the tools' own sign-in, never an account with Koloft.
