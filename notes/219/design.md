# Fork a session from the sidebar (#219) — design

Issue #219: right-click a session row → **Fork**: a new session that carries on from the
same conversation, so the user can try a second approach from the same point without
typing `/fork` in the TUI (the tool's own text screen) and then hunting for the copy.

Line numbers are on today's tree (commit `d1283f0`). Versions probed on this Mac,
2026-10-07: Claude Code 2.1.292, Codex CLI 0.159.3. This design was checked once by an
independent agent against the code; its findings are folded in below.

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
2. A new row appears in the same workspace the way any new session appears — the pending
   bar and the title `Starting…` (`PENDING_SESSION_TITLE`, `src/shared/types.ts:484`;
   Codex builds the same row at `codexSessions.ts:385`), then the real title once the tool
   names it — and its tab is selected. The tab strip shows the backend's name
   (`Claude Code` / `Codex`) until then, as a new session does (`App.tsx:359–365`).
3. It runs in the parent's folder — the parent's worktree when it has one (§2).
4. Inside the tab the tool shows the whole conversation so far; the user types the next
   thing and goes a different way.

Mockup: `index.html` next to this file — six frames: cold row today/after, running row
today/after, a moment after the click, and option 2's C8 dialog. Built by
`build-mockup.cjs` from `mockup-body.html` plus the app's compiled stylesheet inlined
whole; it loads nothing from outside (the only `http` strings in it are two license
comments and the `xmlns` of an inline `data:` SVG mask, all inside the app's own CSS).

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

| Kind | How the fork is started | What binds the tab | Differs from the others |
| --- | --- | --- | --- |
| Local Claude Code | the shim runs `claude --resume <parent> --fork-session` (plus `--settings` and the account the balancer picks, as any launch) | its own SessionStart, which Claude sends with `source=fork` and the new id (probed, §3) | the hook gate change in §3 is what lets it bind |
| Remote (ssh) Claude Code | the machine's tab script runs `claude --resume <parent> --session-id <new> --fork-session` in a new tmux session named `k-<new>`; account picked like a fresh start | the same SessionStart, through the hook mirror | `--session-id` is passed so tmux naming and `launchMode` key on the new id, never the parent's (which may be live); Claude honours it (probed, §3), so the hook's `tmux rename-session k-<session_id>` (`hooks.ts:51`) lands on the name Koloft tracks (`sshHost.ts:616–619`, `tmuxSessionName` = `k-<id>`, `remote/launch.ts:74`) |
| Local Codex | `codex --remote <url> -C <cwd> … fork <threadId>`, same `CODEX_HOME` as the parent thread (a thread lives in the home it was started in, CODEX§15) | the `thread/fork` response the observer already tracks (`codexObservation.ts:201`, `change: 'switch'`) | no account pick: the fork must use the parent's home; an archived parent is refused with today's "Archived in Codex. Run codex unarchive …" message (`codexSessions.ts:925`; `thread/fork` on an archived thread not probed) |
| Remote (ssh) Codex | left out | — | remote Codex sessions do not run yet (#99); no row of that kind can exist, so nothing to hide |

**Where the fork runs (the same rule for all three kinds).**

- The parent row has a `worktreeState` and its `worktreePath` exists → fork there, in
  the worktree, straight away. No occupied-worktree dialog: sharing the parent's worktree
  is what option 1 (§6) means, and the one case the dialog handles (another session is
  working there) is the fork's normal case.
- Otherwise a running parent forks in `row.cwd`; a cold parent goes through today's
  resume plan (`src/main/resumePlan.ts:68` `planResume`): folder exists → that folder;
  worktree gone → rebuild it (`mode: 'rebuild'`), then fork there; no folder → the
  "transcript only" toast.

Why the worktree rule is explicit: Koloft today relies on Claude re-entering a `-w`
worktree on resume (cold rows resume at `resumeCwd`, `resumePlan.ts:80–83`, often the
root; a running row's `cwd` is the transcript head's, `workspaces.ts:964,993`). A fork
does not re-enter: the 2.1.292 binary strips the worktree record on a fork
(`effectiveFork` → `uOe(e, {stripWorktreeSession:!0, stripRelocatedCwd:!0})`, read from
the minified code) and runs the re-enter only on the non-fork branch (read, not run; §7).
So the fork is told the worktree path directly, and its row then has no `worktreeState`:
a later resume of the fork after its worktree is deleted takes `planUnboundRebuild`
(`resumePlan.ts:60`), not the saved record. Codex has no such record on a thread; a Codex
fork adopts the worktree from its folder like any Codex session (`codexSessions.ts:662`).

## 3. The two facts that shape the code

**Fact A — Claude's `--fork-session` start says `source=fork` with the new id, and Koloft
drops those.** Probed (`probe-claude-fork.cjs`: a temp `HOME` with no login, a seeded
transcript under `.claude/projects/<slug>/<id>.jsonl`, `--settings` with a SessionStart
hook that logs its stdin, `ANTHROPIC_BASE_URL` pointed at a closed port so no model call
can go out, `-p hi`; raw log deleted because it held this machine's paths, the script
reproduces it). Claude 2.1.292:

| Launch | Hook got |
| --- | --- |
| `--resume <p> --fork-session --session-id <new>` | `source=fork`, `session_id=<new>`, transcript path under `<new>.jsonl` |
| `--resume <p> --fork-session` | `source=fork`, a fresh random `session_id` |
| `--resume <p>` (control) | `source=resume`, `session_id=<p>` |

Today that report dies twice: `src/main/hooks.ts:43` exits before writing the tab's
binding snapshot (`$reg/$tab.json`), and `src/main/hookRouting.ts:18` `ownsHookReport`
rejects it. Both exist to keep a `/fork` daemon copy — which inherits the parent tab's
hook settings — from claiming the parent tab (CC§5).

The thing that tells the two apart: the parent tab already has a snapshot; a fork tab
Koloft started has none. A fork tab is a new tab with a new id, so its `$reg/$tab.json`
cannot exist yet; on top of that both launch paths wipe it before the tool starts
(`hooks.ts:293–294` `writeTabHookSettings`, called per tab from `src/main/index.ts:1406`;
`src/main/remote/launch.ts:121` `rm -f "${H}.json"`). So:

- `hooks.ts:43` becomes: drop a `start` with `source=fork` only when `$reg/$tab.json`
  already exists.
- `hookRouting.ts:18` becomes `if (report.source === 'fork') return !boundSessionId`.

A `/fork` typed inside any tab (the fork tab included) is still dropped: its tab has a
snapshot. A `/background` move (CC§5) is held by the **script gate alone**: the window's
claude ends with `prompt_input_exit`, which is in `EVICTING_END_REASONS`
(`backends/claude.ts:93`) and untracks the tab (`:593–595`), so on the Koloft side
`boundSessionId` is already empty when the daemon's `source=fork` start lands — but the
`end` record is the snapshot, the file exists, and the script drops it. The new
`hooks.test.ts` case therefore seeds an `end` record first, then fires the fork start, and
expects nothing written (§5).

**Fact B — a fork is not a resume, and every "run once" guard keys on `resumeSessionId`.**
Passing the parent id as `resumeSessionId` breaks a live-row fork three ways:
`backends/claude.ts:729` answers `unavailable: running`; `host/sshHost.ts:616–620` names
the tmux session after the parent and `attach -d`s it; `codexSessions.ts:631,649` throw
"already open" and `:379` paints the parent row running. So the fork travels as its own
field (`fork` on the request, `forkSessionId` on the launch) and skips those guards. One
guard stays on purpose: `codexSessions.ts:919` `trackLaunch(req.sessionId)` keeps the
parent key in `launchingKeys` while the fork starts, so a second Fork click during that
second or two is refused with today's "This Codex session is already opening." toast.

Forking a live Claude session is allowed by Claude (`claude --resume <id> --fork-session`
"makes ANOTHER copy, it is not a takeover", CC§5 line 431), and the fork writes a new
transcript under a new id (probed: the hook's `transcript_path` is `<new>.jsonl`), so the
two-writers data loss in #14 does not apply.

## 4. Code it touches

Rough size: about +130 / −10 lines under `src/`, in 11 files.

| File | Change | ~lines |
| --- | --- | --- |
| `src/shared/types.ts:1290` `SessionResumeRequest` | `fork?: true` | 1 |
| `src/shared/types.ts:303` `CreateTabOptions` | `forkSessionId?: string` | 1 |
| `src/main/claudeArgs.ts:10` `claudeArgv` | `forkSessionId` → `--resume <id>` then `--fork-session` (same id check as `resumeSessionId`); `--session-id` stays allowed next to it | 6 |
| `src/main/host/host.ts:30` `ClaudeLaunch`, `host/localHost.ts:46`, `host/sshHost.ts:74,616` | carry `forkSessionId`; ssh: `sid = spec.resumeSessionId ?? randomUUID()` unchanged (a fork mints), `machineClaudeArgs` passes `sessionId` when forking | 8 |
| `src/main/backends/claude.ts:668` `resume()` | when `req.fork`: same host/home/cwd/mode logic (`'direct'` and `'rebuild'` only; `'renamed'` and `'main'` never arrive for a fork), then `createTab(host, { forkSessionId: sid, … })` with no `resumeSessionId`, so `:816–822` registers it as a fresh launch (pending row) and the pty carries no resume intent | 10 |
| `src/main/hooks.ts:43` | the snapshot-exists gate (Fact A) | 1 |
| `src/main/hookRouting.ts:18` | `return !boundSessionId` (Fact A) | 1 |
| `src/main/codexSessions.ts:922` `resumeRun`, `:634` `launchRun` | `req.fork`: skip `waitForPrevious`, keep the archived check, launch with `forkSessionId`; in `launchRun`: `home = homeFor(resumeSessionId ?? forkSessionId)`, no `pickHome`, argv `fork <nativeId>`, no `resumeKey`, no `resumeSessionId` on the pty; `trustFolder`/worktree adoption unchanged | 15 |
| `src/renderer/src/resumeFlow.ts:147` | `forkSession(target, row)`: worktree row with the folder present → `runResume` at `worktreeState.worktreePath`; running row → `row.cwd`; cold row → `resumePlan` then `planToStep`, with a `dialog` plan turned into a direct spawn at `plan.worktreePath`; `runResume` sends `{ ...req, fork: true }`, adds the tab with `title: BACKEND_LABEL[kind]`, no `sessionId`, no `resuming`, and never sets `resumeLaunch` or the in-flight lock (those paint the parent row); `resumeFailureMessage` takes the verb so the toast says `Fork failed` | 30 |
| `src/renderer/src/components/WorkspaceSidebar.tsx:615,642` | `forkItem(row)` menu line in both branches | 15 |
| `src/renderer/src/components/WorkspaceSidebar.tsx:296–303` `menuItemCount` | running 3 → 5 and cold 5 → 6, counting the lines each branch really renders (today's running menu already has 4 `.mi` lines, `:618–638`): `menuPosFor` (`:132`) uses the count to keep the menu on screen near the window's bottom edge, and a short count clips the last line | 2 |
| `src/preload/index.ts:129`, `src/main/index.ts:3555` | nothing: `sessions:resume` carries the flag | 0 |

Not touched: `shim.ts` — `--fork-session` is a value-less flag; the loop at `:198–215`
sets `resume=1` on `--resume` and takes the last of `--resume`/`--session-id` as `sid`, so
the "exact" registration carries the new id when one is passed and the parent's when not;
`handleRegistration` (`claude.ts:244`) uses only `tabId` and `cwd`. `ResumeDialog.tsx` —
a fork never opens it. `UNAVAILABLE_NOTICE` and `STILL_RUNNING_NOTICE` (`resumeFlow.ts:25–27`)
keep their text (the second one is the §8 cut).

## 5. Tests

Existing tests that change — only the two e2e menu pins:

- `test/e2e/lifecycle.spec.ts:568,575` (T-LIFE-11) and `test/e2e/aggregate.spec.ts:229`
  (T-AGG-05) pin the whole menu with `toEqual` → add `Fork`. T-LIFE-11's `noForbidden`
  (`:558–563`) rejects any row-menu line matching `/worktree/i`; "Fork" passes it.
- `test/e2e/remote-workspace.spec.ts:287` (E-RW-03) checks subsets → no change.

Existing unit tests that stay green and stay as they are: `test/unit/hookRouting.test.ts:17,23`
pass `PARENT` as the bound id, and `test/unit/hooks.test.ts:269` fires a `startup` first,
so both keep describing the bound-tab case the gate still covers.

New, one per behavior:

- `test/unit/hookRouting.test.ts`: `ownsHookReport({event:'start', source:'fork',
  sessionId: FORK}, undefined)` → `true` (a fork start is the tab's own while nothing is
  bound).
- `test/unit/hooks.test.ts`: a fork start on a tab with no snapshot writes
  `$reg/$tab.json`; a fork start after an `end` record (the `/background` case) writes
  nothing.
- `test/unit/claudeArgs.test.ts`: fork argv order (`--resume <id> --session-id <new>
  --fork-session`), bad id refused.
- `test/unit/sshHost.test.ts`: `machineClaudeArgs` passes the minted id on a fork.
- `test/unit/resumeFlow.test.ts`: a worktree row forks at its worktree path; a live row
  forks at its cwd without a plan; a cold row forks through the plan and an occupied
  worktree raises no dialog; the request carries `fork`; the parent row is never marked
  launching; the failure toast says Fork.
- `test/unit/codexSessions.test.ts`: a fork launches `fork <threadId>` in the parent's
  home, picks no account, leaves the parent row as it was, and an archived parent is
  refused.
- `test/e2e/claude-session.spec.ts`: Fork on a running row → a second row binds under a
  new id with the parent's transcript copied, the parent still running; Fork on a cold
  row → same, parent still cold; `env.claudeCalls` shows `--resume <parent> --fork-session`.
- `test/e2e/codex-session.spec.ts`: Fork on a cold Codex row → fake-codex sends
  `thread/fork`, a new row binds, the parent row stays cold.
- `test/e2e/remote-resume.spec.ts`: Fork on a cold remote row → fake-ssh runs the tab
  script with `--resume <parent> --session-id <new> --fork-session`, a new row lights up
  from the mirror.

Fixtures: `test/e2e/fixtures/fake-claude.js:45,163,391` learns `--fork-session` (new id
from `--session-id` or random, copy the parent transcript, SessionStart `source: 'fork'`,
cwd as launched — no worktree re-enter); `fixtures/fake-codex.js:526` learns the `fork`
subcommand (`thread/fork {threadId}`, the server side at `:270` already handles it).

## 6. The one product question

**Where does the fork run?**

1. **In the parent's folder (recommended).** The parent's worktree when it has one, else
   its folder, through today's resume cwd logic; no dialog, no new screen. Cost: two
   sessions share one worktree and both edit it — the fork's normal case, which the app
   already allows when a cold worktree row is resumed "in the same worktree", and #221
   (warn when two sessions write the same file) is the planned answer. It is the smallest
   thing that does what #219 asks.
2. **"Fork…" opens the New Worktree Session dialog (C8) pre-filled.** The fork lands in
   a fresh worktree (mockup frame 6). Cost: a new aim kind in
   `WorktreeSessionDialog.tsx` and `useSessionLaunch` (the hint line and the start button
   change wording), a worktree per fork even for a quick second try, and an unprobed
   Claude combination — `-w <name>` together with `--resume --fork-session`: the fork
   strips the worktree record (§2), so whether `-w` re-attaches one is not known; Codex
   would use Koloft's own worktree, as a new Codex worktree session does. Overlaps #223
   (race N worktree sessions).
3. **Both lines, "Fork" and "Fork in new worktree…".** Costs of 2, a longer menu, and
   T-LIFE-11's `noForbidden` (`lifecycle.spec.ts:558–563`) forbids any row-menu line
   matching `/worktree/i`, so that pin and its reason would have to change.

## 7. Inferred, not checked

Probed and settled on 2.1.292 (`probe-claude-fork.cjs`, no login, see §3): the
`source=fork` start, the new `session_id`, `--session-id` honoured next to `--resume
--fork-session`, and the new transcript path. Still open:

- That a fork of a `-w` parent does not re-enter the worktree: read from the 2.1.292
  binary (the re-enter runs only on the non-fork branch; the fork strips
  `worktreeSession`), not run. The `-p` probe cannot show it: with the transcript in the
  root slug, the control `--resume` also reported the root as `cwd` at SessionStart
  (the re-enter, if any, comes after the hook in `-p` mode). The design does not depend
  on the answer — it hands the fork the worktree path either way. Probe: the same seeded
  repo in an interactive pty, `--resume <p> --fork-session`, then `pwd` through a Bash
  tool call or the status line.
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
  (`thread/resume`), not probed. Probe: `node probe-codex-proxy.cjs <checkout> fork` with a
  `CODEX_HOME` holding a copy of a real `auth.json` (CODEX§15's method) and a thread that
  has had one turn.
- That `thread/fork` on an archived thread is refused by Codex: not probed; the design
  refuses it in Koloft first.
- That a fork of a live Codex thread (the parent open in a sibling app-server on the same
  `CODEX_HOME`) is accepted by Codex: not probed.
- That the Codex worktree resource shared by parent and fork is not removed while either
  runs: `codexSessions.ts` has no worktree removal on `stop()` (grep found none), but the
  scheduled-job "Close it" path was not read.
- Option 2 only: `-w <name>` with `--resume --fork-session` (see §6).

## 8. Cuts

- No keyboard shortcut for Fork.
- No "Fork" for a pending row.
- A cold row whose session is running outside Koloft (`runningClaudePid`,
  `claude.ts:729`) gets today's "still running … would start a second copy" toast on Fork
  too; forking it would be legal for Claude, but the plan code would need a second answer
  and a second toast for one rare case.
- Remote Codex: none exists (#99).
