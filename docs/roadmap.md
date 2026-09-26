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
   The one gap is Codex: Koloft creates the worktree for a Codex worktree session, and
   Codex leaves it in place when it exits. Nobody removes it yet (#116).
5. A file opens in the Workbench **on your intent only** — nothing follows the agent's
   writes around by itself.

A request that pulls against one of these is closed even when it is a good idea, and even
when it works. That is what "judged against" means.

## Planned

### Tier 1 — orchestration: the session is the unit

- **Worktree session bootstrap** — a setup script, copying gitignored files, a port offset,
  so a fresh worktree is usable the moment its session starts. Creating the worktree
  session itself already works; cleanup afterwards is Claude Code's, not Koloft's.
- **Broadcast input** — type once, send to the sessions you selected. The workspace →
  session tree is the first reliable "select N sessions" unit Koloft has had, so the
  scope is unambiguous: the rows you picked, nothing implied.
- **Command palette** — jump to any session across workspaces, and reach actions by name.
  Finding a session *inside* one workspace is already solved by the flat tree; this is
  the cross-workspace half.

### Tier 2 — review: where Koloft can still grow

- **Comment back into the session** — the aggregated diff already exists in the Changes
  view; the missing half is sending a hunk plus a note back into the conversation, and
  jumping to the Claude turn that produced a hunk.
- **Plan-mode surfacing** — read-only rendering of a plan first; approve/reject only once
  the TUI's input mapping is proven against the fake-claude harness.

### Tier 3 — guardrails

- **Measure-first performance backlog** — the file watcher, cold start, a Zustand audit,
  pty-host isolation. Each carries the symptom that would justify it; none is scheduled
  on a hunch.
- **Changes stream memory** — every diff block lives in the DOM and the count is
  unbounded. Measure before folding.
- **PDF previews outside the guest budget** — one PDFium process per changed PDF, not
  counted against the 12-guest cap.
- **An orphaned edit buffer** — a dirty buffer on a tab that claude's own exit closed has
  no owner afterwards.

## Deliberately not doing

Reopen one of these only with new evidence, not a new argument.

- **Mobile clients or a relay service** — an architectural mismatch. Koloft sessions are
  plain Claude Code or Codex sessions, so remote-control tools that work on those tools
  already work alongside Koloft. (Remote *workspaces*, where Claude runs on another
  machine over ssh with no relay service, are a different thing and exist, in alpha.)
- **Checkpoints / rewind** — native in Claude Code (`/rewind`). At most, surface the list.
- **Split panes / tiled layouts** — high cost on xterm.js for a window whose centre is
  one TUI.
- **An MCP management UI** — commodity; only if it is trivially cheap.
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
- **A saved prompt library** — it would mirror the tool's own `/` menu inside Koloft's
  scarcest surface, against "the centre is 100% the tool's own UI". Koloft can only ever
  chase Claude Code's and Codex's native commands and skills there.
- **pty → utilityProcess** — no observed jank. Folded into the performance backlog with
  the trigger that would justify it.
- **Undo-close tab** — a closed session stays in the list as a cold row with *Resume*,
  and closing a working or approval-pending session asks first. There is nothing left to
  undo.

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
  Codex TUI,
  which is why it has the whole centre. That is not the same as keeping a free-floating
  shell, which is a non-goal.
- **Anti-patterns with a track record of backlash**: telemetry, forced login, hiding the
  terminal, auto-hide-on-blur without an opt-out, ambiguous broadcast scope. Koloft has
  none of the first three and will not add them.
