# #362 — say how to keep or drop a worktree session's work

Issue #362 (GitHub issue): "After a worktree session is done, nothing says how to keep or drop the work".

## Today

A person starts a session with **New worktree…**. The agent works in its own copy of the
repository, `<repo>/.claude/worktrees/<name>`. The person opens Workbench ▸ Files ▸ Changes,
looks at the work, and wants to keep it or throw it away. Nothing on screen says how.

- **Changes view.** `ChangesView` (`src/renderer/src/components/ChangesView.tsx:467-553`)
  draws a file list on the left (`.cv-side`, 224 px by default and resizable through
  `sideWidth`, `ChangesView.tsx:469`) and the diff stream on the right (`.cv-stream`). The only
  strip above the stream is the error or "too large" one (`banner`, `ChangesView.tsx:452-463`,
  class `.cv-banner`). With no changes the stream says `No changes against the base.`
  (`CHANGES_MSG.empty`, `changesModel.ts:308`). It already gets the session (`session` prop,
  `ChangesView.tsx:56`) and the tab's folder (`root`).
- **Which tabs carry `session.worktree` today** (read from the code, not run):
  - Claude Code, local: yes (`SessionTracker.resolveWorktree`, `src/main/sessionTracker.ts:978-984`).
  - Codex, Muse, Antigravity, local: yes (`StoredSessions.bind`, `src/main/storedSessions.ts:775-776`).
  - Any remote (SSH) tab: no, by design. ADR-0025 keeps a remote session's place in its path
    field (`docs/adr/0025-remote-workspace-key-in-the-path-field.md:8-9`), and the tracker skips
    the name for remote tabs on purpose (`sessionTracker.ts:554-555`, marked ADR-0025). Its
    `treeRoot` still points into the worktree.
- **Sidebar ▸ session row ▸ Close** never loses work:
  - Claude Code: the pty is killed (`backends/claude.ts:286-294`), which sends SIGHUP
    (`node_modules/node-pty/lib/unixTerminal.js:226-228`); CC then keeps the folder, its lock
    and the branch (CC§4).
  - Codex, Muse, Antigravity: Koloft removes the worktree when the run ends **only if nothing
    was touched** (`storedSessions.ts:884-885` → `removeUntouchedWorktree`,
    `src/main/index.ts:4247-4260`; `SessionWorktrees.untouched`, `sessionWorktrees.ts:189-212`).
- **`koloft session close`** (`src/main/agentSessions.ts:1204-1226`) closes the tab and the row,
  and removes the worktree and its branches (`removeTree` unlocks first,
  `sessionClose.ts:56-66`). It refuses while anything would be lost: uncommitted files, or a
  commit on no other branch and no remote branch (`whatIsLeft`, `sessionClose.ts:44-53`).
  Which branches it deletes: the worktree's HEAD branch plus `worktree-<folder name>`
  (`closingTree`, `sessionClose.ts:11-22`).
  - **On a remote tab it removes no worktree today** (read from code, not run): it reads the
    tree with the Mac-only `projectInfoFor` (`index.ts:4210-4225`); a remote Claude `treeRoot`
    is a bare machine path and a remote Codex/Muse/Antigravity one is an `ssh://` key, which
    `projectInfoFor` returns with no `worktreeName` (`projectInfo.ts:18`), so `closingTree` is
    `null` (`sessionClose.ts:12`). Tracked in #413 and #948.
- **The way into the main folder** is the folder row's menu, opened by right-click or a 350 ms
  hover (`WorkspaceSidebar.tsx:123`, `:483-495`); a click only selects. Its item reads
  `New Claude session` / `New Codex session` / … when two or more agents are listed, else
  `New session` (`namedMethods`, `App.tsx:394-398`). The `+` on a git folder row is
  `New worktree…` (`WorkspaceSidebar.tsx:202-205`), which does not lead there.
- **The agent guide** tells sessions: "commit it, merge its branch from the main checkout, then
  close" (`src/shared/agentGuide.ts:236`). The owner's report on #362 (2026-10-22) shows a Claude
  `-w` session reads that as `git -C <main folder> merge …`, which Claude Code refuses; a `!`
  command typed by the person is refused the same way. What worked: a new session in the main
  folder, merge there.

## Proposal

One strip at the top of the Changes stream — a second `.cv-banner`, the same element and class
as today's "too large" strip — shown when the tab's session runs in a worktree. It sits above
the file blocks **and** above `No changes against the base.` No new button, no new CSS class.

**The worktree name** comes from the renderer, by path alone: `session.worktree` when set, else
the `<name>` in `…/.claude/worktrees/<name>` of the tab's `treeRoot` (the path part of an
`ssh://` key, `barePath` in `src/shared/remoteKey.ts`). This gives remote tabs a name without
touching main or ADR-0025. The path rule moves from `src/main/resumePlan.ts:59-71`
(`worktreeHomeRoot` / `worktreeNameAround`) to `src/shared`, as plain string code.

**Text** (`<New … session>` is the menu item's label; `X` the worktree name):

- **Full** — a local tab whose worktree is under `<repo>/.claude/worktrees/`:
  > Worktree “X” — closing this tab keeps the work. **Keep:** commit here, right-click the
  > folder row ▸ `<New … session>` and ask it to merge this worktree’s branch; then run
  > `koloft session close` here. **Drop:** ask this session to discard everything, then
  > `koloft session close`.
- **Keep only** — a remote tab, or a worktree somewhere else (made by hand):
  > Worktree “X” — closing this tab keeps the work. **Keep:** commit here, right-click the
  > folder row ▸ `<New … session>` and ask it to merge this worktree’s branch.
- **Claude Code adds** one sentence to either: “Git on the main folder is refused here, `!` too.”

Why the two forms:

- Remote: `koloft session close` removes no worktree there today (above; #948), so the strip
  must not promise it.
- Hand-made worktree outside `.claude/worktrees/`: `closingTree` would delete its HEAD branch,
  which may be a branch the person uses elsewhere. A pull request's worktree is made at
  `.claude/worktrees/pr-<n>` (`gitSteps.ts:41`), so it gets the full form: close deletes only
  the local copy of the pull request's branch, and only once its commits are on the remote
  (`whatIsLeft`).
- "Drop" stays in this session: a reset to the start and a clean run inside the worktree, so
  Claude's guard has nothing to refuse; then `whatIsLeft` finds nothing and close removes the
  tree, unlocking it first. No second session, no `/exit` (which offers Remove only for a `-w`
  tree, CC§3/§4, not for an opened existing one).
- The strip never names the branch: a `-w` or Koloft-made tree is on `worktree-<name>` (CC§3;
  `sessionWorktrees.ts:249`), a pull request's is on its own branch, and the screen has no
  branch value. The merging session finds it.

**Agent guide** (`agentGuide.ts:236`, shared by all four agents) — replace the last sentence:
"Koloft has no merge button: to bring a worktree session's work into the main checkout, commit
it, then have a session in the main checkout merge its branch — start one with `koloft session
new` (no `-w`), since a Claude Code worktree session's git is refused outside its worktree and
Codex asks first. On this computer, close afterwards to remove the worktree; on another machine
(SSH), close does not remove it yet."

### Each kind of tab

| Tab | What it shows |
| --- | --- |
| Claude Code, local | Full form + Claude sentence, label `New Claude session` (or `New session`). |
| Claude Code, remote (SSH) | Keep-only form + Claude sentence. No close sentence: close removes no remote worktree today (read from code, not run; #948). That the guard refuses on the machine as it does on the Mac: inferred, not checked. |
| Codex, local | Full form, `New Codex session`. |
| Codex, remote | Keep-only form, same reason as remote Claude. |
| Muse, local / remote | As Codex, `New Muse session`. |
| Antigravity, local / remote | As Codex, `New Antigravity session`. |
| Hand-made worktree (any agent, local) | Keep-only form. |
| Any tab in the main folder | No strip. |

### Code that changes (about 40–50 lines under `src/`)

- `src/shared/` (new small module or `remoteKey.ts`): `worktreeNameIn(treeRoot)` — path rule
  moved from `resumePlan.ts`, which then imports it (~8 lines, net ~3).
- `src/renderer/src/components/changesModel.ts`: `worktreeFinishHint(session, root, label)`
  returns the full text, the keep-only text, or `null` (~18 lines; texts in `CHANGES_MSG`).
- `src/renderer/src/components/ChangesView.tsx`: one more `.cv-banner` after `banner` (~6 lines).
- `src/renderer/src/components/FilesView.tsx`: read `s.settings.sessionMethods` from the store
  (it already uses `useStore`, `FilesView.tsx:84-161`) and pass the label to `ChangesView`
  (~6 lines). The menu's rule (`App.tsx:394-398`) moves into `src/shared/sessionBackend.ts`
  beside `listedBackends` so both use it (~8 lines). Named difference: `App.tsx` also filters by
  "installed" (`probed`, App state, not in the store); FilesView uses "turned on" only, so the
  label differs from the menu only when an agent is turned on but not installed.
- `src/shared/agentGuide.ts:236`: the sentence above.

## Question for the owner

Where should the strip go, and how much should it do?

1. **(Recommended) A strip at the top of the Changes stream, text only.** Seen at once, above
   the files or the empty message, in all 8 kinds of tab; ~45 lines, reuses `.cv-banner`. The
   person still opens the main-folder session by hand (right-click, one click).
2. **A grey note under the file list (`.cv-note` after `.cv-list`), as the issue first said.**
   Same text and code size. It stays in view while the list scrolls (`changesView.css:14-18`);
   the one cost is that it wraps to many lines at the default 224 px width (the column can be
   dragged wider).
3. **Option 1 plus a button in the strip: "Merge in a new session".** One click starts a session
   of the same agent in the main folder whose first message asks it to merge this worktree's
   branch. ~40 more lines (`window.api.terminal.create` with `firstPrompt` exists), a
   two-property style so `.cv-retry` does not wrap, and one e2e case per agent; the issue asked
   for no new button.

## Facts used

- A `-w` session's Bash tool refuses commands it cannot prove stay in the worktree:
  `docs/claude-code-contract.md` §3. That it refuses `git -C <main folder> merge` and a typed `!`
  command: the owner's report on #362, 2026-10-22, local — **not yet in the ledger**; the
  implementing PR adds it to §3.
- That the guard lets `koloft` commands through: confirmed on CC 2.1.309, run in a worktree
  session (to be added to §3 by the implementing PR).
- `-w <name>` makes `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`; an existing
  worktree is opened with bare `claude`, never `-w`: `docs/claude-code-contract.md` §3.
- `/exit` offers Keep / Remove for a `-w` tree: `docs/claude-code-contract.md` §4.
- SIGHUP keeps the worktree, its lock and branch: `docs/claude-code-contract.md` §4 and §1;
  node-pty's `kill()` sends SIGHUP: `node_modules/node-pty/lib/unixTerminal.js:226-228`.
- Codex `/exit` keeps the worktree, branch and HEAD: `docs/codex-cli-contract.md` §6.
- A Codex worktree tab cannot write `.git` from its sandbox and asks before it commits:
  `docs/codex-cli-contract.md` §29. That it asks twice and then merges into the main folder: the
  owner's report on #362, local.
- Muse and Antigravity, git outside the folder: not probed (no entry in
  `docs/muse-code-contract.md` or `docs/antigravity-cli-contract.md`).
- `koloft session new` without `-w` starts in the main folder: read from code
  (`agentSessions.ts:581-584`, `workspaces.ts:271`), confirmed.
- `koloft session close` run by a Codex, Muse or Antigravity tab on itself, locally: inferred,
  not checked. No e2e case covers it — `codex-session.spec.ts`, `muse-session.spec.ts` and
  `agy-session.spec.ts` never run it; `agent-tools.spec.ts:422-546` runs it from the fake Claude
  only; the opt-in `agent-tools-real-smoke.spec.ts:785-…` has a real Codex close a *child* by tab
  id, not itself.
- That an agent asked to "discard everything" resets to the start and cleans untracked files so
  that `whatIsLeft` then passes: inferred, not checked.
- Close removes no remote worktree today: read from code, not run (#413, #948).

## Tests

- **Unit, `test/unit/changesModel.test.ts`** — `worktreeFinishHint`: `null` for a main-folder
  session; the full form for a local `.claude/worktrees/` tree; the keep-only form for a remote
  `ssh://` tree and for a hand-made one; the name read from the path when `session.worktree` is
  absent; the Claude sentence only for Claude. No full-copy pin.
- **Unit** for the moved path rule: its existing callers' tests (`resumePlan`) keep passing; one
  case for an `ssh://` key.
- **E2E, `test/e2e/workbench-changes.spec.ts`** — new case: a session from
  `openWorktreeSession` shows the strip with its name, with a change listed and with none; a
  main-folder session in the same workspace shows none.
- **E2E, `test/e2e/codex-session.spec.ts`** — a Codex worktree tab shows the strip with
  `New Codex session` and without the Claude sentence.
- **E2E, `test/e2e/remote-worktree.spec.ts`** — E-RW-14 gains one assertion: the remote `-w`
  tab shows the keep-only strip, with no `koloft session close`.
- Muse and Antigravity: same code path as Codex apart from one word; covered by the unit case.
- No test for `agentGuide.ts` (copy only).

## Out of scope

- Making `koloft session close` remove a remote worktree (#413, #948).
- Naming the branch in the strip (needs a git read the screen does not do today).
- A merge button (option 3 is the owner's call).
- Putting "installed" (`probed`) into the store so the label matches the menu even for an agent
  that is turned on but not installed.
