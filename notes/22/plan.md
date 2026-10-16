Checked against origin/main by an independent reviewer (16 points); all folded in below.

Review points:
1 taken — the start sweep runs when the restore has settled (`resumeAwake(...).finally`), later than the reviewer's spot: awake tabs resume after `restoreOpenTabs()` returns, and `tabReady` waits for each to bind.
2 taken — History lines carry `sessionId`; a remote folder is tidied only when the machine is connected and that session is not alive.
3 taken — `dirExistsOrThrow`; a throw reads "folder kept: machine unreachable".
4 taken — a remote tidy first waits (up to 10 s) for the session to leave `remoteSync.alive(host)`.
5 taken — dropped from inferred.
6 taken — `removeUntouchedCodexWorktree` re-checks `dirExists` before its toast.
7 taken — `quitting()` dep; a pty exit while quitting writes its line and sweeps nothing.
8 taken — `taken` also rejects names in `job.history[].worktree`.
9 taken — "folder removed" only when the folder or branch was there when the tidy began.
10 taken — the sweep covers the listed folders plus History names; `pendingTidy`, `tidied` and the 20-line limit are gone. The match is the stamp shape, not the prefix (the prefix would eat a sibling job's folders).
11 taken — one small memory survives (`killedRuns: tabId → jobId`): a deadline-killed run never bound, so its tab's `treeRoot` is the workspace root and no folder match can find it; its pty exit sweeps the job through this map.
12 taken — BB-E08 unchanged; the deadline order is a unit test, said so in §5.
13 taken — own `.hist-folder` span; `histText` untouched.
14 taken — all four tests added (§5).
15 taken — a GitHub issue, not in this PR.
16 taken — §4 rewritten; remote Claude Code is "the same, with one wait first".

# Plan: Koloft tidies a scheduled run's folder on its own (#22, with #349's worktree half)

Words: "run folder" = the worktree `<workspace>/.claude/worktrees/<name>` and its branch `worktree-<name>`. "Cold row" = the greyed session row in the sidebar that resumes a session on click. "History" = the list at the bottom of the Scheduled jobs dialog. "Sweep" = one pass over a job's run folders that removes what is safe to remove.

Owner's decision (2026-10-15): "This must not be left to a person to delete. Cleaning up the worktree, the folder and the resources should be the job's or Assist's own work."

## 1. What happens today

- Each run in a git workspace gets its own folder and branch (`src/main/cronRunner.ts` `runDue`; the name from `worktreeBase` in `src/shared/cronNames.ts`). `LiveRun.worktree` remembers it; `lineOf` copies it onto the History line and nothing else (`cronRunner.ts:214-220`).
- Only a "Close it" job that ended clean removes its folder: `closeIfFinished` → `whatIsLeft` → `closeForGood` → `closeSessionFully` (`src/main/index.ts:3504-3526`), which kills the tab (a pty exit), removes the tree and archives the row.
- Every other end leaves the folder and branch: ⌘W and `koloft session stop` both reach `onPtyExit` (`index.ts:2027`), which writes "Closed by you" (BB-M06 asserts the folder stays, `test/e2e/cron.spec.ts:492-493`); the start deadline (`killRun` drops the run from `live`, so its pty exit is ignored); quit (`quitSweep` writes "Ended — Koloft quit"; for Codex, `before-quit` runs `stopAll()` first, so those runs reach `onPtyExit` while quitting, `index.ts:2668-2680`); a crash (nothing).
- Quit remembers every open tab with a session id, run tabs too (`rememberOpenTabs`, `index.ts:598-620`), and the next start resumes them awake (`restorePlan`, `src/main/openTabs.ts:61`; `resumeAwake`, `index.ts:3610`). A resumed run is a normal tab, not a `LiveRun`.
- `removeTree` unlocks the folder a killed Claude Code left locked (CC§4), removes it, deletes the branches (`src/main/sessionClose.ts:49-60`). `whatIsLeft` names uncommitted files and commits on no other branch, and answers "git could not read …" when git fails (`:24-46`).
- The job card counts folders named `<slug>-*` (`countRunFolders`, `index.ts:3571-3574`).
- A cold row whose folder is gone rebuilds it on click: Claude Code `rebuildWorktree` (`src/main/backends/claude.ts:110,821`, local and remote through the host's git; `src/main/resumePlan.ts:84-96` picks the branch or the original commit), Codex `treeRemoved → rebuild` (`src/main/codexSessions.ts:1240`). No test does this for a scheduled run's row yet.
- Codex removes an untouched worktree when its tab closes (`codexSessions.ts:1300` → `removeUntouchedCodexWorktree`, `index.ts:3528-3539`); a run that committed is not untouched.
- `taken` (`cronRunner.ts:422-426`) checks the Codex record, the folder and the branch — once all three are gone a name is free again.
- Remote: `ClaudeBackend.stop` fires `endRemoteTmux` without waiting and kills the local pty at once (`claude.ts:233-240`), so `onPtyExit` can run while claude still works on the machine. `remoteSessionGone(host, id)` = `remoteSync.connected(host) && !alive(host).has(id)` (`claude.ts:599-602`). `sshHost.dirExists` answers false when ssh fails; `dirExistsOrThrow` throws (`src/main/host/sshHost.ts:474-482`). A tab enters the tracker when its shim registers (`claude.ts:298`), with the launch cwd; the worktree becomes its `treeRoot` only when the hook binds.

## 2. What changes

Koloft sweeps a job's run folders when a tab in one of them closes and when Koloft starts. The cold row stays, so a run can still be resumed (folder rebuilt on click). A folder in use (a session open or asleep in it) is left alone without a word; a folder whose removal would lose work, or whose machine cannot be asked, is kept and its line says why. No toast, no notification: History says what happened, the card's count moves.

| End of the run | Today | After |
|---|---|---|
| "Close it" job, turn ended clean | folder + branch removed, row archived, "Done — closed itself" | unchanged |
| ⌘W or `koloft session stop` | folder stays, "Closed by you" | folder + branch removed, cold row stays: "Closed by you" + "folder removed" |
| same, a file uncommitted or a commit only here | folder stays | folder stays: "folder kept: Changes not committed" |
| same, another session open or asleep in that folder | folder stays | folder stays, line unchanged; when that session closes the folder goes and the line gains "folder removed" |
| killed at the start deadline | folder stays if claude made one | once the process is gone the folder goes; "folder removed" only if there was one |
| Koloft quits with the run open | "Ended — Koloft quit"; the tab comes back at the next start | unchanged at quit and at start (the tab is back, so the folder is in use); when you close that tab the folder goes and the line gains "folder removed" |
| a cold row resumed and closed again | folder stays | folder goes when the tab closes, its line gains "folder removed" |
| crash, or folders from runs no longer in History | nothing | at the next start every run folder of the job is swept; a folder with no line goes silently and the count drops |
| remote run, machine unreachable or claude still running there | folder stays | folder stays: "folder kept: machine unreachable" / "… still running on the machine"; retried at the next sweep |
| `koloft session close` | folder + branch removed, row archived | unchanged |

## 3. Code

`src/shared/cronNames.ts`: `isRunFolderOf(slug, name)` = `^<slug>-\d{6}-\d{4}(-.+)?$`, the inverse of `worktreeBase` — never the bare prefix, since "nightly-report-v2-…" is another job's folder.

`src/main/sessionClose.ts`, new `tidyTree(git, info, dirExists): Promise<{ removed: boolean; kept: string[] }>` (~30 lines), next to `removeTree`:
1. `tree = await closingTree(git, info)`; `there = await dirExists(info.treeRoot)` — a throw becomes kept `machine unreachable: <problem>`.
2. Not there → delete the `tree.branches` that exist; `removed` = a branch was deleted.
3. There → `whatIsLeft`; else `removeTree`. Any kept answer that is a git failure ("git could not read / list / remove …") re-checks `dirExists`: gone = another remover won (`closeSessionFully`, Codex's `leftWorktree`, Claude's own `/exit` removal, CC§4) → `removed: true`; still there → kept with that text. A real "Changes not committed" is kept as is.

`src/main/index.ts` (~40 lines):
- `tidyRun(root, worktree, sessionId?)` dep: for an `ssh://` root `sessionId` is required; `await claudeBackend.waitRemoteGone(host, sessionId)` first — `'unreachable'` / `'alive'` → kept with that word, no git call. Then `tidyTree(hostGitOut, cronRunTree(root, worktree), (d) => hosts.of(d).dirExistsOrThrow(d))`, then `codexSessions?.store.removeUnusedResourcesAt(treeRoot)` (keeps the record while the cold row's member uses it, which is what lets the click rebuild).
- `inUse(root, worktree)` dep: the `allSessions()` filter of `whatClosingWouldLose` (`:3493-3496`) plus the `sleepers` scan of `removeUntouchedCodexWorktree` (`:3530`) — not `occupantOf`, which skips remote sessions.
- `listRunFolders(root, slug)` replaces `countRunFolders`: `listDir` names that pass `isRunFolderOf`. The count is the list's length.
- The pty exit handler (`index.ts:1990-2030`) reads `sessionOfTab(e.id)` (`treeRoot`, `sessionId`) at its top and passes them to `cronRunner.onPtyExit(e.id, left)`.
- `cronRunner.sweepLeftFolders()` is called in `resumeAwake(...).finally` (`index.ts:3604`), where `openTabsRestored` turns true: sleepers are in `sleepers`, and `tabReady` (`:3676-3685`) has waited for each resumed tab to bind, so `inUse` sees them all.
- `removeUntouchedCodexWorktree`: re-check `dirExists` before the toast (two removers, one folder).
- `quitting: () => quitCommitted`.

`src/main/backends/claude.ts` (~12 lines): `waitRemoteGone(host, sessionId)`: `pokeNow`, then poll every `REMOTE_EXIT_POLL_MS` for up to `REMOTE_EXIT_WAIT_MS` (the 10 s `noticeRemoteExits` gives; it also covers a start whose first pull is not done yet): `'gone'` as soon as `remoteSessionGone` holds; at the end `'unreachable'` if not connected, else `'alive'`.

`src/main/cronRunner.ts` (~55 lines):
- `RunnerDeps`: `tidyRun`, `inUse`, `listRunFolders` (replacing `countRunFolders`), `quitting()`.
- `lineOf` also copies `run.sessionId`.
- `sweep(job)`: names = `listRunFolders(root, slug)` ∪ `history[].worktree`, minus every job's `LiveRun.worktree`, minus names in `inFlight` (a per-folder set — `removeTree` may take minutes and two sweeps may meet), minus `inUse` names (left alone, no word). On an `ssh://` workspace only History names with a `sessionId` (a listing from an unreachable machine must never read as "nothing there"); the first `'unreachable'` answer ends that job's sweep and marks its other remote names the same, so one dead machine costs one wait. Each name → `tidyRun(root, name, line?.sessionId)`; the result lands on the newest History line with that `worktree`: `removed: true` or `kept: reasons.join('; ')` (a kept line is retried at every sweep). Save and push only when a line changed; `refreshFolders` always.
- `onPtyExit(tabId, left?)`: a live run writes its line as today. Then, unless `quitting()`, sweep the run's job, the job in `killedRuns.get(tabId)` (set by `killRun`, consumed here), and every job whose `worktreeHomeOf(workspacePath)` contains `left.treeRoot` — this is how a tab restored after quit and a resumed cold row tidy when they close. If `left.sessionId` is set and the matching History line has none, write it there first (so a remote folder from before this change becomes sweepable once its row is resumed and closed).
- `closeIfFinished`: puts `run.worktree` in `inFlight` for the life of the `closeForGood` promise, so the pty exit `closeSessionFully` causes never sweeps the folder it is removing.
- `sweepLeftFolders()`: `sweep(job)` for every job in a git workspace.
- `taken`: also true when `job.history.some((h) => h.worktree === name)` — after a tidy the record, folder and branch are all gone, and the first run's cold row would otherwise resume `direct` into a second run's folder of the same name.

Shared: `HistoryLine` gains `sessionId?`, `removed?: true`, `kept?: string`; `cleanHistory` keeps them (`src/main/cronStore.ts:63-66`). `src/shared/cronHistory.ts`: new `histFolder(h)` → `'folder removed'` / `'folder kept: …'` / `''`; `histText` untouched. `CronJobsDialog.tsx:732`: `{folder && <span className="hist-folder">{` · ${folder}`}</span>}` after `.hist-wt`.

Estimated runtime code: about +150 / −10 lines under `src/`.

## 4. Four tab kinds

- Local Claude Code: as above. The killed worktree is locked; `removeTree` unlocks first (CC§4).
- Local Codex: the same. Codex's own untouched-worktree removal may win the race (`tidyTree` step 3 and the Codex toast re-check). The record stays while the cold row uses it, so the click rebuilds.
- Remote Claude Code: the same, with one named difference — the tidy waits up to 10 s for the session to leave `remoteSync.alive(host)`, otherwise keeps the folder with "machine unreachable" or "still running on the machine", and touches only folders a History line ties to a session id. A remote folder no line names is not touched; the card still counts it (leftover, §7).
- Remote Codex: does not exist (#99).

## 5. Tests

| Behavior | Which test goes red / where it lives |
|---|---|
| ⌘W removes folder and branch, cold row stays, click rebuilds the folder and resumes the same session id | BB-M06 changed (`cron.spec.ts:453-503`; today it asserts the folder stays) |
| ⌘W with an uncommitted file keeps the folder, `.hist-folder` says why | new BB-M20, reusing BB-M18's `/write report.md` setup |
| Quit-ended run: the tab is back at the next start with its folder and line unchanged; ⌘W then removes it and the line gains "folder removed" | BB-M08 changed |
| Codex job without "Close it": ⌘W → folder gone, cold row, click → rebuilt | new test in `codex-session.spec.ts` |
| Remote job: ⌘W → folder gone on the machine | BB-M17 extended (fake remote) |
| "Close it" paths: line stays "Done — closed itself" with no folder word | BB-M18, BB-M19 gain one `.hist-folder` assert |
| Deadline: the killed tab's later exit sweeps its job through `killedRuns`; nothing is swept while quitting; a line whose folder never existed gets no word | `cronRunner.test.ts`, new describe (unit-only: fake-claude's hang mode hangs before `makeWorktree`, `test/e2e/fixtures/fake-claude.js:130-135`, so BB-E08 has no folder to assert on and stays unchanged) |
| Start sweep leaves an in-use folder alone without a word; a live run's folder is never swept; a folder with no History line goes silently; a closed normal tab in a run folder sweeps that job and writes its session id onto the line; a "Close it" close never sweeps its own folder | `cronRunner.test.ts` |
| Remote: only History names with a session id are swept; `kept` is written for 'unreachable' / 'alive'; one 'unreachable' ends the job's sweep | `cronRunner.test.ts`; `claudeBackend.test.ts` for `waitRemoteGone` |
| `taken` rejects a History name | `cronRunner.test.ts` (BB-E03 describe) |
| `tidyTree`: already gone → branch deleted, `removed`; `dirExists` throws → kept with the problem; a git failure on a folder that is gone by the re-check reads `removed`; an uncommitted file is kept | `sessionClose.test.ts` (real git) |
| `sessionId`, `removed`, `kept` survive a reload for closed/ended/failed | `cronStore.test.ts` |
| `isRunFolderOf` matches the stamp shape, not a sibling job's prefix | `cronNames.test.ts` |

## 6. Upgrade

Nothing to migrate. At the first start after the update the sweep lists every run folder of every job (not only the 20 History lines): clean folders go, dirty ones stay with a reason on their line if they have one, cold rows stay and still resume. Old History lines have no `sessionId`, so on a remote workspace the old pile stays until each row is resumed and closed once (that close writes the id and sweeps); locally the pile goes at once. A renamed job's old-slug folders are caught only through History.

## 7. Risks and "inferred, not checked"

- Two removers on one folder (`closeSessionFully`, Codex's own removal, Claude's `/exit`, two sweeps): `inFlight` and the `dirExists` re-check make the loser read `removed`, never a spurious "kept" or toast.
- A resume that `tabReady` gave up on (`RESUMED_TAB_READY_MS`) may still be starting when the start sweep runs; its folder is then in no list and could go. Rare; the row still rebuilds on click.
- `withSuffix` can cut the slug when a long name needs `-2…` or the hex tail; that folder misses `isRunFolderOf` (today's count misses it too) and is caught only through History.
- Leftover, filed as an issue: a remote folder no History line names (a run killed before it bound, or older than History) stays on the machine.
- Leftover, filed as an issue (point 15): a folder half-deleted when SIGHUP hit Claude's own removal (CC§4) reads "Changes not committed" forever.
- Inferred, not checked: `sessionOfTab(e.id)` still answers at the top of the pty exit handler; `sshHost.listDir` on an unreachable machine (whatever it returns, the remote sweep never acts on the listing alone); `realpathSafe(workspacePath)` matches the Codex record's path; `projectInfoFor` on an `ssh://` key returns it unchanged.
- #349's "row vanishes" half is not in this plan.
