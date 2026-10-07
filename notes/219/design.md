# Fork a session from the sidebar (#219) — design

Issue #219: right-click a session row → **Fork**: a new session that carries on from the
same conversation, so the user can try a second approach from the same point without
typing `/fork` in the TUI (the tool's own text screen) and then hunting for the copy.

Line numbers are on today's tree (branch `fix/283-member-dropped-at-bind`, commit
`d1283f0`). Versions probed: Claude Code 2.1.292, Codex CLI 0.159.3 (`claude --version`,
`codex --version` on this Mac, 2026-10-07).

## 1. What the user sees

One new line in the session row menu, **Fork**, on every row that is a session: a running
row and a cold (not running) row. A pending row (still starting) keeps its single
**Cancel** line.

| Row | Today | After |
| --- | --- | --- |
| Cold | `2h ago` · Resume ↩ · Reveal in Finder · Copy session ID · Keep running · Remove from list | `2h ago` · Resume ↩ · **Fork** · Reveal in Finder · Copy session ID · Keep running · Remove from list |
| Running | Reveal in Finder · Copy session ID · Keep running · Close | **Fork** · Reveal in Finder · Copy session ID · Keep running · Close |
| Pending | Cancel | Cancel (no change) |
| Remote row | as above with "Copy path" in place of "Reveal in Finder" | same, plus **Fork** |

Clicking Fork:

1. The menu closes. Nothing happens to the row that was clicked: a running parent keeps
   running, a cold parent stays cold.
2. A new row appears in the same workspace, the way any new session appears (the pending
   bar, placeholder title, then the real title once the tool names it), and its tab is
   selected. It runs in the parent's folder (same worktree or main — see §6).
3. Inside the tab the tool shows the whole conversation so far; the user types the next
   thing and goes a different way.

Mockup: `index.html` next to this file — five frames: cold row today/after, running row
today/after, and a moment after the click. Built by `build-mockup.cjs` from
`mockup-body.html` plus the app's compiled stylesheet inlined whole; it loads nothing from
outside (the only `http` strings in it are two license comments and the `xmlns` of an
inline `data:` SVG mask, all inside the app's own CSS).

Where it lives: `src/renderer/src/components/WorkspaceSidebar.tsx` `renderMenu()`, the
running branch at lines 615–641 and the cold branch at 642–676. Fork sits first in the
running menu and right after Resume in the cold menu because both are "start a tab from
this row" actions; the rest of each menu is about the row itself.

What #14 says about forks Koloft cannot see: the copies that `/fork` typed inside the TUI
makes are hosted by Claude's daemon and never get a Koloft tab (CC§5). This feature does
not change that. A Koloft-started fork is an ordinary tab, bound by its own SessionStart,
listed from `~/.claude/projects` like any session. #14's "fork copy visibility" item stays
open.

## 2. How it works, by tab kind

Each of the four kinds, with what differs.

| Kind | How the fork is started | What binds the tab | Differs from the others |
| --- | --- | --- | --- |
| Local Claude Code | the shim runs `claude --resume <parent> --fork-session` (plus `--settings`, the account the balancer picks, as any launch) | its own SessionStart, which Claude sends with `source=fork` | the hook gate change in §3 is what lets it bind |
| Remote (ssh) Claude Code | the machine's tab script runs `claude --resume <parent> --session-id <new> --fork-session` in a new tmux session named after `<new>`; account picked like a fresh start | the same SessionStart, through the hook mirror | `--session-id` is passed so tmux naming and `launchMode` key on the new id, never the parent's (which could be live) |
| Local Codex | `codex --remote <url> -C <cwd> … fork <threadId>`, same `CODEX_HOME` as the parent thread (a thread lives in the home it was started in, CODEX§15) | the `thread/fork` response the observer already tracks (`codexObservation.ts:201`, `change: 'switch'`) | no account pick: the fork must use the parent's home |
| Remote (ssh) Codex | left out | — | remote Codex sessions do not run yet (#99); no row of that kind can exist, so nothing to hide |

The cwd rule is the same for all three: a running parent forks in the folder its tab runs
in; a cold parent goes through today's resume plan (`src/main/resumePlan.ts:68`
`planResume`: folder exists → that folder; worktree gone → rebuild it; worktree in use by
another tab → the existing two-choice dialog; no folder → the "transcript only" toast).

One named difference for a **Claude parent that lives in a `-w` worktree** (local and
remote alike): Claude strips the worktree session record when it copies the transcript for
a fork (binary 2.1.292: `effectiveFork` → `uOe(e, {stripWorktreeSession:!0,
stripRelocatedCwd:!0})`, read from the minified code, not run). The fork runs in the
worktree folder, but its row has no `worktreeState`, so a later resume of the fork after
the worktree is deleted takes `planUnboundRebuild` (`resumePlan.ts:60`, rebuild from the
folder name and branch) instead of the saved record. Codex has no such record on a thread,
so a Codex fork is the same as any Codex session in that folder (Koloft adopts the
worktree from the folder, `codexSessions.ts:662`).

## 3. The two facts that shape the code

**Fact A — Claude's `--fork-session` start says `source=fork`, and Koloft drops those.**
Read from the installed 2.1.292 binary's minified code (`strings` + grep, not run):

```
Ne = r.forkSession || xe || (z!==void 0 && !CRn(z,r)) ? "fork" : "resume"   // then PY(LB(), Ne, {sessionId, …})
"Error: --session-id can only be used with --continue or --resume if --fork-session is also specified."
```

So a Koloft-launched fork fires SessionStart with `source: "fork"`. Today that report dies
twice: `src/main/hooks.ts:43` exits before writing the tab's binding snapshot
(`$reg/$tab.json`), and `src/main/hookRouting.ts:18` `ownsHookReport` rejects it. Both
exist to keep a `/fork` daemon copy — which inherits the parent tab's hook settings — from
claiming the parent tab (CC§5, `hooks.test.ts:269`, `hookRouting.test.ts:17,23`).

The thing that tells the two apart: the parent tab is already bound; a fork tab Koloft
started is not. A fork tab is a new tab with a new id, so its `$reg/$tab.json` cannot
exist yet; on top of that both launch paths wipe it before the tool starts
(`hooks.ts:293–294` `writeTabHookSettings`, called per tab from `src/main/index.ts:1406`;
`src/main/remote/launch.ts:121` `rm -f "${H}.json"`). So:

- `hooks.ts:43` becomes: drop a `start` with `source=fork` only when `$reg/$tab.json`
  already exists (the tab has a session; this start is somebody's copy).
- `hookRouting.ts:18` becomes `if (report.source === 'fork') return !boundSessionId`.

A `/fork` typed inside any tab (the fork tab included) is still dropped: its tab has a
snapshot. A `/background` move (CC§5) is still dropped for the same reason.

**Fact B — a fork is not a resume, and every "run once" guard keys on `resumeSessionId`.**
Passing the parent id as `resumeSessionId` breaks a live-row fork three ways:
`backends/claude.ts:729` answers `unavailable: running`; `host/sshHost.ts:616–620` names
the tmux session after the parent and `attach -d`s it; `codexSessions.ts:631,649` throw
"already open" and `:379` paints the parent row running. So the fork travels as its own
field and skips those guards. Forking a live Claude session is allowed by Claude
(`claude --resume <id> --fork-session` "makes ANOTHER copy, it is not a takeover", CC§5
line 431), and the fork writes a new transcript under a new id, so the two-writers data
loss in #14 does not apply (inferred from the new id, not measured).

## 4. Code it touches

Rough size: about +125 / −10 lines under `src/`, in 11 files.

| File | Change | ~lines |
| --- | --- | --- |
| `src/shared/types.ts:1290` `SessionResumeRequest` | `fork?: true` | 1 |
| `src/shared/types.ts:303` `CreateTabOptions` | `forkSessionId?: string` | 1 |
| `src/main/claudeArgs.ts:10` `claudeArgv` | `forkSessionId` → `--resume <id>` then `--fork-session` (same id check as `resumeSessionId`); `--session-id` stays allowed next to it | 6 |
| `src/main/host/host.ts:30` `ClaudeLaunch`, `host/localHost.ts:46`, `host/sshHost.ts:74,616` | carry `forkSessionId`; ssh: `sid = spec.resumeSessionId ?? randomUUID()` unchanged (a fork mints), `machineClaudeArgs` passes `sessionId` when forking | 8 |
| `src/main/backends/claude.ts:668` `resume()` | when `req.fork`: same host/home/cwd/mode logic, then `createTab(host, { forkSessionId: sid, … })` with no `resumeSessionId`, so `:816–822` registers it as a fresh launch (pending row) and the pty carries no resume intent | 10 |
| `src/main/hooks.ts:43` | the snapshot-exists gate (Fact A) | 1 |
| `src/main/hookRouting.ts:18` | `return !boundSessionId` (Fact A) | 1 |
| `src/main/codexSessions.ts:922` `resumeRun`, `:634` `launchRun` | `req.fork`: skip `waitForPrevious`, launch with `forkSessionId`; in `launchRun`: `home = homeFor(resumeSessionId ?? forkSessionId)`, no `pickHome`, argv `fork <nativeId>`, no `resumeKey`, no `resumeSessionId` on the pty; `trustFolder`/worktree adoption unchanged | 15 |
| `src/renderer/src/resumeFlow.ts:147` | `forkSession(target)`: live row → `runResume` straight at `row.cwd` (`mode: 'direct'`); cold row → `resumePlan` then `planToStep` as today; `runResume` sends `{ ...req, fork: target.fork }`, adds the tab with no `sessionId` and no `resuming`, and never sets `resumeLaunch` or the in-flight lock (those paint the parent row) | 25 |
| `src/renderer/src/components/WorkspaceSidebar.tsx:615,642` | `forkItem(row)` menu line in both branches | 15 |
| `src/renderer/src/components/WorkspaceSidebar.tsx:296–303` `menuItemCount` | running 3 → 4, cold 5 → 6: `menuPosFor` (`:132`) uses the count to keep the menu on screen near the window's bottom edge; one short and the last line clips | 2 |
| `src/preload/index.ts:129`, `src/main/index.ts:3555` | nothing: `sessions:resume` carries the flag | 0 |

Not touched: `shim.ts` — `--fork-session` is a value-less flag; the loop at `:198–215`
sets `resume=1` on `--resume` and takes the last of `--resume`/`--session-id` as `sid`, so
the "exact" registration carries the new id when one is passed and the parent's when not;
`handleRegistration` (`claude.ts:244`) uses only `tabId` and `cwd`. `hooks.ts:293` and the
remote tab script already clear the snapshot before a launch.

## 5. Tests

Existing tests that go red and change:

- `test/unit/hooks.test.ts:269` "a fork's SessionStart does not clobber the tab's binding
  snapshot" → split: with a snapshot present it is dropped (as now); with none it is
  written (the tab's own fork start).
- `test/unit/hookRouting.test.ts:17,23` → a fork start is rejected once the tab is bound,
  owned while nothing is bound.
- `test/e2e/lifecycle.spec.ts:568,575` (T-LIFE-11) and `test/e2e/aggregate.spec.ts:229`
  (T-AGG-05) pin the whole menu with `toEqual` → add `Fork`.
- `test/e2e/remote-workspace.spec.ts:287` (E-RW-03) checks subsets → no change.

New, one per behavior:

- `test/unit/claudeArgs.test.ts`: fork argv order (`--resume <id> --session-id <new>
  --fork-session`), bad id refused.
- `test/unit/sshHost.test.ts`: `machineClaudeArgs` passes the minted id on a fork.
- `test/unit/resumeFlow.test.ts`: a live row forks at its cwd without a plan; a cold row
  forks through the plan; the request carries `fork`; the parent row is never marked
  launching.
- `test/unit/codexSessions.test.ts`: a fork launches `fork <threadId>` in the parent's
  home, picks no account, and leaves the parent row cold/running as it was.
- `test/e2e/claude-session.spec.ts`: Fork on a running row → a second row binds under a
  new id with the parent's transcript copied, the parent still running; Fork on a cold
  row → same, parent still cold; `env.claudeCalls` shows `--resume <parent> --fork-session`.
- `test/e2e/codex-session.spec.ts`: Fork on a cold Codex row → fake-codex sends
  `thread/fork`, a new row binds, the parent row stays cold.
- `test/e2e/remote-resume.spec.ts`: Fork on a cold remote row → fake-ssh runs the tab
  script with `--resume <parent> --session-id <new> --fork-session`, a new row lights up
  from the mirror.

Fixtures: `test/e2e/fixtures/fake-claude.js:45,163,391` learns `--fork-session` (new id
from `--session-id` or random, copy the parent transcript, SessionStart `source: 'fork'`);
`fixtures/fake-codex.js:526` learns the `fork` subcommand (`thread/fork {threadId}`, the
server side at `:270` already handles it).

## 6. The one product question

**Where does the fork run?**

1. **In the parent's folder (recommended).** A running parent: the folder its tab runs
   in. A cold parent: through the resume plan, dialog included. No new screen. Cost: two
   sessions can share one worktree and both edit it — which the app already allows when a
   cold worktree row is resumed next to a sibling, and #221 (warn when two sessions write
   the same file) is the planned answer. It is the smallest thing that does what #219 asks.
2. **"Fork…" opens the New Worktree Session dialog (C8) pre-filled.** The fork lands in a
   fresh worktree. Cost: a new aim kind in `WorktreeSessionDialog.tsx` and
   `useSessionLaunch`, a worktree per fork even when the user only wants a quick second
   try, and the §2 worktree-record difference still applies (the fork would run in a
   worktree Claude's own record does not name — whether `-w <name>` plus
   `--fork-session` restores it is not probed). Overlaps #223 (race N worktree sessions).
3. **Both lines, "Fork" and "Fork in new worktree…".** Costs of 2 plus a longer menu.

## 7. Inferred, not checked

- That `claude --resume <id> --fork-session` fires SessionStart `source=fork` in a window:
  read from the 2.1.292 binary's minified code (`PY(LB(), Ne, …)` with `Ne = forkSession ?
  "fork" : "resume"`), not run. CC§5 saw `source=fork` only for daemon-hosted forks.
  Probe: temp `HOME` with a seeded transcript, `claude --resume <id> --fork-session
  --settings <file with a SessionStart hook that logs its stdin>`, read `source`. Needs a
  login, so it is the implementer's run, not this design's.
- That `--session-id <new>` with `--resume <old> --fork-session` is accepted: from the
  binary's error text ("--session-id can only be used with --continue or --resume if
  --fork-session is also specified") and CC§5's own daemon command line, not run here.
- Codex, measured on 0.159.3 (`probe-codex-fork.cjs`, a logging ws server, and
  `probe-codex-proxy.cjs`, a logging proxy in front of a real `codex app-server --stdio`,
  both on a temp `CODEX_HOME`; raw logs deleted since one held this machine's name — the
  scripts reproduce them): `codex --remote <url> -C <dir> fork <uuid>` parses, connects,
  and bootstraps the same way Koloft's resume does — `initialize`, `initialized`,
  `account/read`, then `thread/read {threadId}`. Not reached: what it sends after a good
  `thread/read`. With `account: null` the TUI stops at its login screen; with a hand-made
  `thread/read` answer it prints "No saved session found with ID …" and exits, exactly as
  `resume <uuid>` does with the same answer, so that check sits before either open call.
  That the next request is `thread/fork {threadId}` is inferred from CODEX§2 (in-TUI
  `/fork` sends `thread/fork` on the current thread) and the parallel with `resume`
  (`thread/resume`), not probed. Probe: `node probe-codex-proxy.cjs fork` with a
  `CODEX_HOME` holding a copy of a real `auth.json` (CODEX§15's method) and a thread that
  has had one turn.
- That a fork of a live Codex thread (the parent open in a sibling app-server on the same
  `CODEX_HOME`) is accepted by Codex: not probed.
- That a Koloft fork of a live Claude session writes only its own new transcript and
  never the parent's: follows from the new id, not measured.
- That the Codex worktree resource shared by parent and fork is not removed while either
  runs: `codexSessions.ts` has no worktree removal on `stop()` (grep found none), but the
  scheduled-job "Close it" path was not read.

## 8. Cuts

- No keyboard shortcut for Fork.
- No "Fork" for a pending row.
- A cold row whose session is running outside Koloft (`runningClaudePid`) gets today's
  "still running" toast on Fork too; forking it would be legal for Claude, but the plan
  code would need a second answer for one rare case.
- Remote Codex: none exists (#99).
