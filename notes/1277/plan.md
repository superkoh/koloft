# Plan: a scheduled run whose agent crashes keeps its tab (#1277)

Checked against the code (on `fix/1324-cron-agent-quit-history`) by an independent review;
its findings are folded in.

## The case

A nightly job starts. Its agent binds and works. Then it crashes (exit code 1, or killed).
Nobody closed anything.

| | today | after this plan |
| --- | --- | --- |
| the tab | closes; the last screen is gone | stays, with its last screen and `· exited (code N)` / `· killed (signal N)` on its row, as any other session tab does since PR #1172 |
| the run's worktree folder | removed at once (unless it has work not committed) | kept while the tab is open; removed (same rules as today) when you close the tab |
| History | `Closed by you` (before PR #1359) / `Agent quit — exited (code N)` (with PR #1359) | `Agent quit — exited (code N)`; the `· folder removed` / `· folder kept: …` part lands when you close the tab |
| the job's next due | the run is over at once, the wait starts | the same: a kept tab is not an open run |

PR #1359 (issue #1324, pull request = a proposed code change) is the History half: it writes
the new `Agent quit` state. This plan builds on it.

## Why today's code closes the tab

Two places decide, from two different signals:

```
pty exits (agent crashed)
   |
   +--> main: CronRunner.onPtyExit
   |       run.state past 'launching'  -> History line
   |       onTabGone -> sweep          -> worktree folder removed      (problem 2)
   |
   +--> renderer: unexpectedExitWanted(tab, exit)
           tab.jobId set and tab.sessionId unset -> "never started" -> close the tab   (problem 1)
           (a fresh run's tab never gets tab.sessionId; only lastSessionId)
```

1. The renderer thinks every fresh scheduled run "never started", so it closes the tab.
2. Even if the renderer kept the tab, main's sweep removes the folder the tab points at,
   and ⇧⌘R (restart) would then start in a folder that is gone. The probe branch's e2e
   BB-M34 shows this: with a renderer-only fix, the folder is gone 5 s later.

## The fix (main decides, the renderer follows)

### 1. Main says "this run had started" on the exit event

- `CronRunner` gets one small `runStarted(run)` (state is past `launching`), used by
  `closeOut` (today's `state === 'launching'` test) and by the new `runStartedIn(tabId)`, so
  the History line and the tab are decided by one test and cannot drift apart later.
- `TerminalExit` gets `runStarted?: true`. Main's pty `exit` handler asks
  `cronRunner.runStartedIn(tabId)` before `teardown` (teardown is where `CronRunner` drops
  the run; the `exit` listeners do not touch cron) and keeps the answer for the event it
  sends the renderer.
- Renderer: `unexpectedExitWanted` drops a scheduled tab only when
  `tab.jobId !== undefined && tab.sessionId === undefined && !exit.runStarted`.
  (`tab.sessionId` still counts: a run brought back after a restart, or a tab resumed with
  ⇧⌘R, has it.)
- Why not the probe branch's `tabEverBound`: it would also work today (it is filled from
  the same bind main sees, and the sessions push reaches the renderer before the exit
  event). Main's flag is picked so History and the tab use one test, not because the
  renderer's is a guess. Cost of the flag: one optional field and one lookup in main.

### 2. Main holds the folder while the kept tab is open

- `CronRunner` gets `kept: Map<tabId, { jobId, worktree, left }>` (`left` is saved at
  exit time, as the session may be gone from the list later).
- `onPtyExit(tabId, left, exit)`: when `exit.unexpected` and the run had started, write the
  `quit` line (PR #1359) and put the tab in `kept`. `onTabGone` still runs as today: it only
  gathers the jobs to sweep (and fills a missing `sessionId` on the line).
- `sweep` skips a worktree a kept tab holds, next to today's check for one an open run
  holds. Every sweep goes through `sweep` (tab exits, a sleeping tab closed, the startup
  `sweepLeftFolders`), so this one check covers them all; old leftovers of the same job are
  still tidied.
- New `cronRunner.tabClosed(tabId)`, called from `killTabPty(tabId, restarting = false)`:
  if the tab is in `kept`, drop it. If its pty is already dead (no exit event will come;
  killing a dead pty only forgets it), call `onTabGone(left, [jobId], tabId)` right away. If
  its pty is alive (a session resumed with ⇧⌘R in that tab), do nothing more: the pty's exit
  then sweeps the way any closed tab does today, after the agent has stopped, not while it
  is still running.
  The sweep then runs with today's rules: no work left → folder and branch go and the
  History line gets `· folder removed`; work left → `· folder kept: …`.
  Every way the renderer removes a tab goes through `closeTab` → `terminal.kill` →
  `killTabPty(…, false)` (the close button, the row's Close, and `keptTabsToClose` when the
  same session runs again in another tab), or is main's own `killedByMain`, which already
  goes through `killTabPty`.
- The window closes or the page reloads with a kept tab open: main's renderer teardown
  forgets every dead pty, and the reloaded page adopts only live ones, so the kept tab is
  gone without a `closeTab`. `CronRunner.onRendererTeardown()` (already called there, empty
  today) drops every `kept` entry and runs `onTabGone` for each, so the folder is tidied
  then instead of staying until Koloft restarts.
- `CH.tabs.moved(old, new)` (already sent by the renderer when ⇧⌘R swaps in the new pty)
  moves the `kept` entry to the new tab id, so the hold follows the tab; between the kill of
  the dead pty and the move, the new live pty already guards the folder (`foldersInUse`).
- Koloft quits with a kept tab open: nothing extra. Kept (ended) tabs are not saved for the
  next launch (`rememberOpenTabs` saves only live ones), and the next launch's
  `sweepLeftFolders` already tidies folders older runs left.

### 3. ⇧⌘R on a kept tab — the choice for the owner (see Question)

## Every kind of tab

The decision and the hold are in main and are keyed by tab id, so all 8 kinds work the
same way: Claude Code, Codex, Muse Code and Antigravity, on this Mac and on a remote
workspace over SSH.

| kind | what is different |
| --- | --- |
| local, all 4 agents | nothing; exit code and signal come from node-pty |
| remote, all 4 agents | the pty is the local ssh. The tab script hands the agent's own exit code to ssh, so a crash there reads `exited (code N)`; one killed there reads 128 + the signal number, e.g. `exited (code 137)`, never `killed (signal N)` (measured, PLATFORM§35). 255 is passed as 254. A dropped link (ssh 255) is not an exit at all: the tab reconnects and the run stays open, as today. The sweep for a remote run already tidies over ssh and needs the History line's `sessionId`, which the run had once it bound. |

## Tests

- e2e BB-M34 (probe branch, `cron.spec.ts`): Run now, wait for the bind, kill the agent →
  the toast, the row's `killed (signal N)`, one tab left, History `Agent quit — killed
  (signal N)` (was `Closed by you`), and the folder still there after a settle. Then close
  the tab → the folder goes and History gets `· folder removed`.
- unit `cronRunner.test.ts`: a quit run is held (no `tidyRun`), a sweep of the same job
  skips it, `tabClosed` of a dead tab sweeps it, `tabClosed` of a live tab leaves the sweep
  to its exit, `onRendererTeardown` sweeps every held one, `tabs.moved` moves the hold.
- unit `closeSession.test.ts`: a scheduled tab with `runStarted` is kept; without it and
  without `sessionId` it is dropped.
- e2e for the picked ⇧⌘R behaviour on a kept tab.
- Other agents and remote: the existing cron specs for Codex, Muse, Antigravity and remote
  Muse (E-RM-05) run; the BB-M34 steps are the same for all, so one remote case with
  fake-ssh is added if the fake can kill the remote agent (not probed yet).

## Site

The sessions page says "A tab that a scheduled job opened may close instead"; that goes.
The scheduled page's `Agent quit` row (PR #1359) says the folder line follows; it changes
to say the folder line comes when you close the kept tab.

## Question for the owner

What should ⇧⌘R (restart) do on a kept tab of a scheduled run whose agent crashed?

1. **Resume the same session in the same folder, as an ordinary session (recommended).**
   This is what ⇧⌘R already does on any kept tab, and what clicking a closed run's grey
   row does today. History keeps the `Agent quit` line; the resumed work is not a new run
   of the job: it gets no `Done` line, Close it does not close it, and the job's next due
   is not skipped while it is open. Cost: smallest change (only the hold moving with the
   tab); a person reading History does not see that the run was picked up again. The
   resumed tab still carries the job's mark, so if the resumed session crashes again
   before it binds, its tab closes like a run that never started.
2. **Count it as the same run again, tracked by the job.** Main turns the kept tab back
   into the job's open run when the resumed session binds (like `reopenedIn` does after a
   restart). History then shows `Done …`/`Closed by you` for it later, Close it can close
   it, and the next due is skipped while it is open. Cost: more code in `CronRunner`
   (adopting a tab it did not start, through `tabs.moved` and the bind); the `Agent quit`
   line is taken out of History when the run comes back (as `reopenedIn` does), so History
   no longer shows the crash.

In both, a crash before the session wrote anything to resume makes ⇧⌘R say "Nothing to
resume": a scheduled tab carries no launch to start again.
