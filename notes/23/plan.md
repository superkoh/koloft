# Plan: Claude's one-time "Bypass Permissions" warning stalls unattended launches (#23 local scheduled jobs, #254 remote machines)

Checked against the code on `main` (d5207a0d) twice by an independent reviewer (first draft: 9 points; this version: 6 points); all are folded in.

## What happens today (main d5207a0d)
- Claude Code 2.1.300 still shows a one-time "WARNING: Claude Code running in Bypass Permissions mode / No, exit / Yes, I accept" screen before SessionStart, for both `--dangerously-skip-permissions` and `--permission-mode bypassPermissions`, on a machine whose user settings lack `skipDangerousModePermissionPrompt: true` (CC§9). Nothing in a background launch answers it, so it stalls.
- Koloft launches Claude with the bypass flag when the Settings ▸ Accounts skip switch is on (default on, `types.ts:409`) and an account is injected (`index.ts:1311` → shim), or when the launch asks for it (a scheduled job's "Never ask" = `skipAll` → `bypass`, `cronRunner.ts:44-47`). A job with "same" permission also gets the flag through the shim when the switch is on.
- Who stalls: a scheduled job's run on a Mac that never accepted the screen (dies at the 90 s deadline; History says only "Claude did not start", `cronRunner.ts:451`); a session started from Discord or ⌘P while nobody is at the Mac; on a remote (SSH) machine, every first bypass launch (#254, seen in the docker lab). An interactive tab, local or remote, shows the screen until someone answers it in that tab. Turning the skip switch on in Settings ▸ Accounts does not ask the question (only Assist setup does, `useAssistSetup.ts:34`), so a Mac can have the switch on and no key.
- Koloft already passes its own settings file to every Claude launch it makes: `--settings "$KOLOFT_HOOK_SETTINGS"` in the local shim (`shim.ts:235`) and `--settings "<tab>.json"` on a remote machine (`remote/launch.ts:127`). Both files are built by one function, `hookSettings` (`hooks.ts:296`), through `writeTabHookSettings` (local, `hooks.ts:398`) and `machineHookSettings` (remote, `backends/claude.ts:1015`).

## Probe (2026-10-15, Claude Code 2.1.300 macOS arm64, scratch `CLAUDE_CONFIG_DIR`, onboarding and folder trust pre-set, python pty)
| Bypass flag | `skipDangerousModePermissionPrompt: true` in | Warning screen |
|---|---|---|
| `--dangerously-skip-permissions` | nowhere | shown |
| `--dangerously-skip-permissions` | a `--settings` file | not shown, opens at the prompt with "bypass permissions on" |
| `--dangerously-skip-permissions` | the user's `settings.json` | not shown |
| `--permission-mode bypassPermissions` | nowhere | shown |
| `--permission-mode bypassPermissions` | a `--settings` file | not shown |
| no bypass flag | a `--settings` file, or nowhere | no screen; Shift+Tab cycles auto → manual → accept edits → plan → auto, bypass never offered, in both runs |

Script and output: `notes/23/` on branch `fix/23-bypass-warning` (removed before the PR). Linux (the remote case) runs the same JS bundle; that the key works there the same way is inferred, not checked — the build step checks it in the docker ssh lab with the lab's own seed (`test/e2e/helpers/docker.ts:333`, `bypassPermissionsModeAccepted`) left out for that run.

## Proposed (option A)
Add `skipDangerousModePermissionPrompt: true` to the settings object `hookSettings` returns. One line covers local Claude tabs, remote Claude tabs, scheduled jobs (local and remote), Discord, ⌘P and `koloft session new` launches: every tab Koloft makes goes through `launchQuietTab` or `terminal:create` → `sessionBackends.create`, and both pass this settings file (the local shim on every interactive launch, the remote tab script as `--settings "<tab>.json"`). Koloft's own `-p` calls and the remote first-run warm-up carry no bypass flag. A launch with no bypass flag is unchanged (probe above). Nothing new is written into the person's `~/.claude/settings.json` or the remote machine's.

Consent then lives in Koloft: the skip switch in Settings ▸ Accounts (default on), Assist setup's "Is that OK?" question, and a job's "Never ask" (with its hint "Never ask can change files anywhere on this Mac"). Assist setup stays as it is: its "Yes, don't ask" still writes the key into the person's own settings (`acceptBypassWarning`, `claudeTrust.ts:59`, pinned by `onboarding.spec.ts:542`); after this change that write no longer matters to Koloft's launches, and the question still works as the one place Koloft asks.

Also: record the probe in CC§9; make the real-claude cron smoke prove it by clearing the key the shared e2e seed writes (`test/e2e/helpers/env.ts:106`) and its own seed (`cron-real-smoke.spec.ts:62`) in its setup; unit test in `test/unit/hooks.test.ts` that the generated settings carry the key.

Out of scope: a `claude` typed by hand inside a Claude session goes through the shim's pass-through branch (`[ -n "$CLAUDECODE" ] && skip=1`), which adds no settings file, so it can still show the screen.

Size: ~2 lines under `src/`, plus the ledger and tests.

## Four tab kinds
- Local Claude Code: no warning screen for any Koloft launch with the bypass flag.
- Remote Claude Code: the same, through the tab's settings file on the machine (Linux behaviour checked in the docker lab during the build).
- Local Codex, remote Codex: nothing (no such screen, CODEX§14; remote Codex does not exist, #99, CODEX§16).

## Upgrade
Nothing to migrate: the next launch after the update carries the key. A Mac or machine that already accepted is unaffected.

## Options for the owner
- **A (recommended):** Koloft answers Claude's warning for every launch it makes (the one line above). Cost: Claude's own warning never shows inside Koloft; the only warning is Koloft's own switch, Assist setup's question and the "Never ask" hint. Turning the switch on in Settings ▸ Accounts still asks nothing.
- **B:** answer it only on machines where the person already accepted once (this Mac's key copied into launches; remote machines get it only if this Mac has it). Cost: more code (~30 lines: a new dependency on the local key, a launch-script flag); a Mac that never accepted keeps stalling scheduled jobs, so the job form and History still need a "this would stall" note.
- **C:** keep Claude's screen; only explain it: a hint in the job form and a History line naming the screen. Cost: unattended launches keep stalling; remote tabs keep showing the screen once per machine.
