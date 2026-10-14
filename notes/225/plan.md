## Plan: Settings ▸ Usage — cost history by day, session, workspace and model

### What the user sees and does

A new **Usage** page in Settings (⌘, or the palette: "Settings ▸ Usage"). On it:

1. A range switch: 7 days · 30 days · 90 days · All.
2. Two big numbers: cost in the range and number of sessions.
3. One bar chart, one bar per day, one colour (so no legend). Hovering a bar shows that day's total and its Claude Code / Codex parts — the only place the split is shown.
4. A switch — Day · Session · Workspace · Model — that changes the list under the chart. Each row shows a name, a small line of context (workspace · model · days), tokens, and cost. A Codex row wears a CODEX badge, a remote row an SSH badge. A model Koloft has no price for shows its tokens and "no price" instead of a dollar figure. Money and tokens are written the way the status line already writes them (`formatCost`, `formatTokens` in `src/shared/usageFormat.ts`): `$6.40`, `$31.4`, `$132`; `410k`, `2.41M`.
5. One line of small print: the figures are API list price for the same tokens — a subscription is not billed per token, so this is a yardstick, not a bill.

Nothing else in Koloft changes: no badge, card or row in the sidebar or the terminal area (`test/e2e/usage.spec.ts` keeps those out).

What is reused and what is new on the screen: the Settings modal, nav, `.set-ph`, the `.seg` switches (as in Settings ▸ Sessions), the `.acct-list` / `.acct-row` rows, the `.acct-badge` and `.acct-meter` pieces are the app's own. New: the CODEX and SSH badge variants (the CODEX one on the `--fable` theme tokens), the `.usage-*` chart rules, and the bar tooltip, which goes to `body` through a portal like every other floating layer (ADR-0013), never a fixed box inside the modal. The page plugs in where the other panes do: one id in `SettingsPaneId` and one entry in `SETTINGS_PANES` (`src/shared/paletteFeatures.ts`, which also feeds ⌘P), one icon in `PANE_ICONS` and one pane branch in `SettingsModal.tsx`.

### Where the numbers come from

Koloft already works out a session's tokens and cost today (`src/main/sessionTracker.ts` for Claude Code, `src/main/codexObservation.ts` for Codex, prices in `src/shared/pricing.ts`), but keeps only one running total per live tab and starts it from zero on every bind — `/clear`, a resume, a restart — and drops it when the tab closes. This feature keeps it: one record per **session per day per model**, holding four token counts. Cost is worked out when the page is read, from the price table — so a price-table update re-prices old days too.

| Tab kind | Where the tokens come from | Day it lands on |
|---|---|---|
| Local Claude Code | Each `assistant` line in the session's transcript (`~/.claude/projects/…/*.jsonl`), which the tracker already reads from byte 0 every time a tab binds; sub-agent transcripts fold into the parent session | The line's own timestamp |
| Remote Claude Code (SSH) | The same lines, from the copy of the machine's `~/.claude/projects` that Koloft already pulls with rsync into its userData folder; the tracker already reads that copy | The line's own timestamp |
| Local Codex | `thread/tokenUsage/updated` frames from the app-server, which carry the thread's running total; Koloft keeps the last total it saw per thread and books the difference. A thread Koloft starts books from zero; a thread it resumes with no saved total takes the first frame as the starting point and books nothing until the next one, so an old thread never dumps its past onto today. The record carries the model learned once when the thread binds; a model change in the middle of a thread is not probed yet | The moment the frame arrives |
| Remote Codex | Does not exist as a tab kind (Codex contract §16); nothing to do |

The workspace of a record is the tab's workspace key (a local path, or `ssh://machine/path`), which main already knows per tab.

Store: one JSON file in userData, like `started-sessions.json`. Claude Code records for a session are rebuilt whenever its transcript is read, with the tracker's own two de-dup rules (one record per `message.id` + `requestId`; a `<synthetic>` model line is skipped), so a resume or restart never double-counts. Codex records are append-only and keep the last-seen total per thread beside them, or the first frame after a Koloft restart would book the whole thread again.

### Existing users after upgrading

- **Claude Code history fills itself in.** When the Usage page opens, Koloft reads the transcripts the sidebar already lists — it walks the same enumeration (`src/main/workspaces.ts` → `aggregateSessions`), so a record's workspace and the session count match the sidebar. How far that reaches is fixed by what is on disk: locally, what `~/.claude/projects` holds for Koloft's workspaces and their worktree buckets; for a remote machine, what the mirror holds for those projects — and the mirror pulls only while the machine is connected and mirrors deletions, so a session deleted on the machine is gone here too.
- **Codex starts at zero.** Codex has no transcript Koloft reads, so the chart counts Codex from the day this version is installed. Old Codex sessions do not show.
- Settings, accounts, sessions, bindings: untouched.

### Left out

- A separate Workbench tab: the Workbench belongs to one session; this page is across sessions, workspaces and days.
- Cost per account, per turn, or per hour.
- Budgets, alerts, exports.
- Back-filling Codex from its own rollout files under `CODEX_HOME/sessions` — not probed yet.
- A split chart (Claude Code vs Codex as two colours): the app's muted palette fails the chart colour checks (every pair reads too grey), so the split lives in the hover only.

### Not probed yet (said as such, nothing built on them)

- That `thread/tokenUsage/updated`'s `total` carries the turns before a resume (if it does not, a resumed thread's first delta is just its first turn, which is fine either way).
- Whether a Codex frame has its own timestamp — if not, the day is the moment it arrives on the Mac.
- Whether a Codex thread can change model mid-way, and what the frame says then.
- How long a first back-fill takes on a big `~/.claude/projects` — if slow, it runs in the background and the page shows "reading…" until done.

### The one decision

**Where it lives**
1. **Settings pane "Usage" (my pick).** One id and one entry in `SETTINGS_PANES` plus an icon gets ⌘P routing for free; touches none of the selectors `usage.spec.ts` forbids. Cost: it is a modal — you cannot keep it open while working.
2. Workbench tab. Always on screen beside the session. Cost: the Workbench is one session's; a cross-session, cross-workspace, cross-day view does not belong to one tab, and every tab would carry a copy.
