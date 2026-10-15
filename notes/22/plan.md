# Plan: tidy the run folders a scheduled job leaves behind (#22)

Checked against the code on `main` (d5207a0d) by an independent reviewer; its eight points are folded in.

## What happens today
- Each run of a job in a git workspace works in its own copy: folder `<workspace>/.claude/worktrees/<slug>-yymmdd-HHMM` (`-2`… if taken), branch `worktree-<name>` (`src/shared/cronNames.ts:30-35`, `cronRunner.ts:61-73,411-415`, `sessionClose.ts:13`). Claude Code makes it itself (`claude -w`, `claudeArgs.ts:39`), local and remote alike; for Codex, Koloft runs `git worktree add` and keeps a record (`sessionWorktrees.ts:130,281-283`).
- The job card already says "N run folders on disk" (hidden at 0, amber past `MANY_RUN_FOLDERS`, `CronJobsDialog.tsx:111,299-308`), counted over the workspace's host, so remote folders count too (`index.ts:3551-3554`).
- Koloft removes a run's folder and branch only for a "Close it" job that finished cleanly (`cronRunner.ts:500-519`: `whatIsLeft` first, then `closeTheRunFully` → `closeSessionFully`, `index.ts:3484-3506`). Remote is covered by BB-M19 (`cron.spec.ts:887-925`).
- Everything else stays: a run closed by hand (⌘W, `koloft session stop`) keeps its folder and a cold session row on purpose, so it can be resumed (BB-M06, `cron.spec.ts:479-499`); a run killed at the start deadline (`cronRunner.ts:438-457`); runs left when Koloft quits (`:555-566`); a crash. The folders pile up, and the card only counts them.

## Three ways
- **A. A "remove" action on the job card.** Click it, and Koloft removes every run folder of that job that is safe to remove; a toast says "Removed 7. Kept 2: changes not committed / still open." The existing "N run folders on disk" text becomes the clickable action (one fewer control than a new button). Safe means: no live or sleeping session on that folder (`index.ts:3474-3477,3510-3511`), and nothing would be lost (`whatClosingWouldLose` / `whatIsLeft`: no uncommitted file, no commit missing from the main branch). A folder with a cold session row goes through `closeSessionFully` (row archived, folder, branch, Codex record); one with no row through `removeTree`. A folder git cannot read (half-made by a deadline kill) is kept and named. ~95 lines.
- **B. Automatic for "Close it" jobs on any end of the run** (stop, deadline, quit), with the same safety check. ~15–30 lines. Also fixes the leftover half of #349.
- **C. A cap: the oldest safe folders are pruned on their own** past a number. ~60 lines.

## Four tab kinds (for A)
- Local Claude Code: as above.
- Local Codex: the same, plus dropping the Codex worktree record (`removeUnusedResourcesAt`, `sessionStore.ts:162`) so the name is free again.
- Remote Claude Code: the same; git and the folder listing run on the machine (`hostGitOut`, `parseRemoteKey` in `removeTree`). Proven for a live run by BB-M19; a folder with no live tab on a remote machine is inferred, not checked.
- Remote Codex: does not exist (#99, CODEX§16).

History lines that name a removed folder need nothing: the History list shows the name as plain text (`CronJobsDialog.tsx:732`).

Inferred, not checked: matching a folder to its cold row (local paths may need `realpathSafe`, remote is an `ssh://` key); #349's "row vanishes" half (the `koloft session stop` path in `agentSessions.ts:858-861` was not traced).

## Question for the owner: who removes a job's run folders?
- **A (recommended): the person, with one click on the job card ("N run folders on disk").** Cost: nothing changes until clicked — the pile grows meanwhile; one click per job now and then.
- **B: Koloft, on its own, but only for "Close it" jobs, at any end of the run.** Cost: such a run can never be resumed once it ends; jobs without "Close it" still pile up; it also settles the leftover half of #349.
- **C: Koloft, on its own, keeping only the newest N safe folders per job.** Cost: folders vanish in the background at a number nobody chose; the most code.
