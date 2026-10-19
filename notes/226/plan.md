# #226 plan (revised 2026-10-19): a workspace may limit itself to some accounts

Mockup: `index.html` next to this file (built from today's `src/renderer/src/styles.css`
and the real markup of the workspace menu, the New Worktree Session checkbox row and
Settings ▸ Accounts). Lines marked **(inferred, not checked)** were not proved by a
command. One question is left for the owner (§9); everything else is decided here.

## 1. What the user sees and does

**Case A — work and personal.** Mia has two Claude subscriptions in Koloft, `work` and
`personal`. She right-clicks the `acme-api` workspace header, picks **Accounts…**, and in
the dialog ticks `work`. From now on every session in `acme-api` — ⌘N, a worktree
session, a scheduled job, a resume, a restart — runs on `work`. The first terminal line
says `koloft: → work · 5h 37% · 7d 52% · the only account acme-api may use`. `personal`
is never used there, even when `work` is at its limit.

**Case B — two work accounts.** Mia later adds `work-2` and ticks it too. Sessions in
`acme-api` spread over `work` and `work-2` as the balancer does today, and when `work`
hits its limit the next start lands on `work-2` — never on `personal`. The first line:
`koloft: → work-2 · 5h 12% · 7d 40% · one of 2 accounts acme-api may use`.

**Case C — all of them at their limit.** Both `work` and `work-2` are walled. A new
session still starts, on the one that resets first, and its first line says
`koloft: every account acme-api may use is at its limit → work (back 14:30)`. Nothing
outside the list is borrowed (the owner's 2026-10-19 comment: "the launch says so rather
than borrowing").

**Case D — an endpoint pinned to a workspace (the old #226 ask).** Mia adds the custom
endpoint `glm` with the new **Add endpoint** button and ticks only `glm` for
`side-project`. Every session there runs on `glm` and its model; the first line reads
`koloft: → glm (custom endpoint · glm-5.2) · the only account side-project may use`.

**Case E — other agents.** The same dialog lists Codex, Muse and Antigravity accounts
under their own headers. A Codex workspace limited to `codex-work` runs its Codex
sessions there. A backend with nothing ticked is not limited for that backend.

**Case F — nothing ticked anywhere.** The default. The workspace behaves exactly as
today; the dialog's hint says so.

**Where it shows.** Settings ▸ Accounts: each limited account's small text names the
workspaces (`limited to: acme-api, acme-web`). The dialog is the only place to change it.

## 2. The shape: a list per workspace (not named groups)

Recommended: **(a) a workspace lists the accounts it may use.**

- It mirrors a setting the code already has: the per-repository git account pick
  `Settings.gitPicks` (`src/shared/types.ts:342`, default `[]` at `:479`, row shape
  `GitRepoPick` at `:83-87`), filled from `DEFAULT_SETTINGS` when missing
  (`src/shared/settingsOps.ts:69`), cleaned of deleted accounts on load
  (`src/shared/gitAccountOps.ts:190-202`), written through its own IPC because
  `sanitizeSettingsPatch` strips such keys from renderer patches (`settingsOps.ts:46-66`).
- New setting: `workspaceAccounts: { workspace: string; accounts: string[] }[]`.
  `workspace` is the workspace key (a local absolute path, or `ssh://host/path` for a
  remote one, `src/shared/remoteKey.ts`). An account is stored as `kind:name`, because a
  name is unique only inside its kind (`AccountPicker.key`, `src/main/accountPicker.ts:131`).
- Cost of (a): ten work repositories mean ten dialogs, and a new work account must be
  ticked in each. Cost of (b) groups: a second thing to name, create, rename and delete, a
  Settings screen for it, and "what does an empty group mean" — for two or three accounts
  it buys nothing. If someone shows up with ten work repositories, add groups then, on
  top of (a) (a group is a saved list).

## 3. The mechanism: one filter, no new picker

Every picker already starts from `usableAccounts(...)`:
Claude `AccountPicker.eligible` (`src/main/accountPicker.ts:135-137`, used by `pick`
at `:180-182`), and `HomeAccountPicker.pick` for Codex, Muse and Antigravity
(`src/main/codexAccounts.ts:144-146`). The change is: filter that pool by the workspace's
list first. Everything after it — keep-the-resumed-account, least-used, round-robin, the
"all walled" fallback — then stays inside the list by itself.

- Order of rules, unchanged inside the list: resumed account (if still allowed and under
  95%) › least-used › round-robin when nothing is measured › first to reset when all are
  walled (`accountPicker.ts:194-207, 223-292`; `codexAccounts.ts:147-162`).
- **Koloft never swaps the account of a running `claude`.** The shim asks main once,
  when `claude` starts (`src/main/shim.ts:393-419`), and `picker.pick` is called only from
  `pickForLaunch` (`src/main/index.ts:1606-1622`). The "automatic switch at a usage
  limit" is the next start: a Restart Session, a resume, or a quit-and-reopen, where
  `keepResumed` drops an account past 95% (`accountPicker.ts:199-207`; e2e E9/E9a/E9b in
  `test/e2e/multi-account.spec.ts:760-818`; Codex the same at `codexAccounts.ts:147-153`).
  So "stays inside the set" means: the filter runs before `keepResumed` and `decide`.
- **A remembered account outside the list loses.** A session that ran on `personal`
  before `acme-api` was limited to `work` resumes on `work` — the owner's rule, "never
  moving a work session onto the personal subscription". For subscriptions the model does
  not change; for an endpoint it does, and the first line says so (`koloft: → glm … ·
  the only account side-project may use`).
- **Banner forms** (the shim prints `banner` as it does today, `shim.ts` reads it from the
  pick answer): one ticked → `· the only account <ws> may use`; several → `· one of N
  accounts <ws> may use`; an endpoint keeps its `(custom endpoint · model)` tag first.
- **All allowed accounts at their limit:** today's behaviour, inside the list: start on
  the first to reset and say so — `koloft: every account <ws> may use is at its limit →
  work (back 14:30)` (`accountPicker.ts:283-289`; Codex `codexAllLimitedNotice`,
  `accountPicker.ts:91-94`, gets the same words). The API-key/endpoint fallback at
  `accountPicker.ts:266-272` fires only for a fallback account that is in the list.
- **No allowed account is usable** (the ticked ones are off, expired or deleted). With an
  empty filtered pool `pick` answers `{ account: null, reason: 'no-accounts' }`
  (`accountPicker.ts:183`), and the shim prints the hard-coded `NO_USABLE_ACCOUNT.claude`
  for any empty answer (`shim.ts:417-419`; it parses only `reason`). So the pick answer
  gains a `message` field, the shim reads it like `reason` and prints it when present:
  `koloft: no account acme-api may use can run this session — change its list
  (right-click the workspace ▸ Accounts…) or fix the account in Settings ▸ Accounts.`
  Codex, Muse and Antigravity throw the same words where they throw
  `NO_USABLE_ACCOUNT` today (`codexSessions.ts:646`, `museSessions.ts:513`,
  `agySessions.ts:444`).
- Nothing ticked for a backend means "any account" for that backend. Deleting an
  account drops it from every list on load, like a git pick (`gitAccountOps.ts:201`);
  removing a workspace drops its row.
- The old per-session endpoint pick folds in as a list of one: pin = a list with only
  `glm`. A one-off "this session only" pick is not done here; it goes to a separate
  issue.

## 4. Where the control lives: the workspace header menu → a dialog

A new item **Accounts…** in the workspace header's right-click menu
(`src/renderer/src/components/WorkspaceSidebar.tsx:700-800`), right after "Scheduled
jobs…" and before "Talk to Assist" (`:756-775`) — inside the `!target.missing` block
(`:722`), since `test/e2e/workspace.spec.ts:137` pins that a missing workspace's menu is
only "Remove workspace". It opens a small dialog built from `BindConductorDialog`'s
parts (`src/renderer/src/components/BindConductorDialog.tsx:120-240`: `.modal`,
`.flabel`, `.field-hint`, `.modal-foot`), with one `.flabel` per backend that has
accounts and one existing multi-select checkbox row per account — the
`.field-check-row` + `.field-label` row the New Worktree Session dialog uses
(`styles.css:2058-2072`), each with the account's usage note. No "Any account" row:
nothing ticked is "any", and the hint under the list says so. Save writes the list
through a new `window.api.accounts.limitWorkspace(wsPath, ids)` IPC, like
`gitAccounts.pick`.

Why not the other two places from the old plan (both skipped twice by the owner, now
decided here):
- **New Session dialog:** it lists workspaces, and the list is set once per workspace,
  not per start. No change there.
- **Settings ▸ Accounts:** a control per account ("which workspaces may use me") turns
  the idea upside down. The pane only *shows* the result, as read-only text on the row.

**Add endpoint** button in Settings ▸ Accounts: added, next to Paste token. Today only
`setAdding('oauth')` is reachable (`src/renderer/src/components/settings/AccountsPane.tsx:192`),
although the "Add custom endpoint" form exists (`:694-711`). E1
(`test/e2e/multi-account.spec.ts:199`) allows "only the verifiable add entries" — an
added account must be probe-checked before it is saved — and an endpoint is probed with
its own model (`multi-account.spec.ts:998`), so the button runs that probe through the
same `accounts.add` path (`AccountsPane.tsx:649-654`) and E1's title names three entries.

The menu is the same for a local and a remote workspace (`ws-head` is one component,
`WorkspaceSidebar.tsx:400-440`), so one screen covers both.

## 5. The eight kinds of session tab

Where the workspace key comes from at pick time, and what the user gets.

| Tab | What happens | Where the key comes from |
|---|---|---|
| Claude Code, local | The same: list › balancer inside it. | Not from the tracker: the shim asks before `claude` starts (`shim.ts:393-410`) and the tab is tracked with `sessionId: ''` (`src/main/sessionTracker.ts:483-491`) until SessionStart, so `workspaceOfTab(tabId)` is empty at pick time. `ClaudeBackend.create` knows `root` (`src/main/backends/claude.ts:826-829`); it records tabId → workspace key at tab start, next to `pickedSkipFlag` (`claude.ts:170, 261-263`), and `handlePickRequest` (`index.ts:1634-1640`) reads it. A fresh worktree tab's `root` is the parent workspace, so the map holds that. For a resume, `root` is the session's own folder (a worktree path for a worktree session), so the key comes from the disk row table instead: `workspaceMgr.workspaceOf(resumeSessionId)` (`src/main/workspaces.ts:270`). |
| Claude Code, remote SSH | The same for the user. Named difference in plumbing: the pick happens before the launch, keyed `launch-<sid>`, not by tab (`src/main/host/sshHost.ts:1086-1087`), so the key rides through `pickAccount(launchKey, resumeSessionId)` → `pickForLaunch` (`index.ts:4840-4841`) as `ssh://host/path`. The key is `wsRoot` (`sshHost.ts:1082`: `fallbackCwd` for a worktree session, else `root`) — whether `wsRoot` is the parent workspace for a *resumed* remote worktree session is **not probed**. The account's env already ships in the tab package (`sshHost.ts:1107-1108`). |
| Codex, local | The same. | `launchRun` computes `workspace` (`src/main/storedSessions.ts:630`) before `prepare(opts)` (`:633`); `workspace` threads `launchRun` → `prepare(opts, workspace)` → `pickHome(resumeSessionId, workspace)` (`codexSessions.ts:645`, `index.ts:1867`). |
| Codex, remote SSH | The same; same `prepare` path, the remote key is the workspace (`codexSessions.ts:655-656`). The token stays on the Mac as today (`test/e2e/remote-codex.spec.ts:122`). | as local |
| Muse, local | The same. | `museSessions.ts:512` → `pickMuseHome` (`index.ts:2013`), same threading. |
| Muse, remote SSH | The same; the credential file is carried as today (`museSessions.ts:526-534`). | as local |
| Antigravity, local | The same, plus one named difference: `trustsFolder(dir)` picks an account with no session, to read that account's trust list (`agySessions.ts:368-372`); `dir` may be a worktree, so it maps through `workspaceFor(dir)` (`storedSessions.ts:453`) first and picks inside that list, or a workspace limited to `agy-work` reads `agy-personal`'s trust list. | `agySessions.ts:443` → `pickAgyHome` (`index.ts:2105`), same threading. |
| Antigravity, remote SSH | The same; `readAgyConfig(account)` and the API key go to the machine as today (`agySessions.ts:598-599`). | as local |

Also covered by the same path: **scheduled jobs** start a tab in `job.workspacePath`
(`src/main/cronRunner.ts:426`), so the tab map holds that key; **worktree sessions** as
in the rows above. A workspace's **Talk to Assist** tab runs in Assist's own folder, not
the workspace (`src/main/discord/conductors.ts:551`), and its workspace comes from
`conductorWorkspaceOf` (`src/main/sessionBackends.ts:132`), so the tab map is filled from
that for a workspace-scoped Assist; the global Assist (`GLOBAL_SCOPE`,
`src/shared/conductors.ts:14`) has no workspace and stays on the whole pool.

**Named difference — tab-less Assist runs stay on the whole pool.** The one-shot targets
(`assistTargets`, `index.ts:1319-1337`; `whyAssistCannotRun`, `:1353-1376`;
`pickedAccountEnv`, `:1624-1632`; `agyOneShotTarget`, `:2161`; the ⌘P route,
`:5110-5116`) pick with no tab and, for ⌘P and the title calls, before any workspace is
known — the route itself decides the workspace. Limiting them would need a second
"which workspace" rule for a run that has none, for a feature whose case is "my
sessions in this repository"; they stay as today, and the plan says so in the PR.

## 6. An existing user after upgrading

- `workspaceAccounts` is missing from `settings.json` → `[]` on load. No workspace is
  limited, every picker sees today's pool. Nothing changes until they open **Accounts…**.
- An endpoint account added in an older build keeps today's rule (used only when every
  subscription is walled) until a list names it.
- The menu gains one item, Settings ▸ Accounts one button; nothing else moves.

## 7. Tests

Unit, change in place: `test/unit/accountPicker.test.ts` (the pool given to `pick` is
filtered; the resumed account outside the list loses; the `message` field),
`test/unit/codexAccounts.test.ts` (the same for `HomeAccountPicker`),
`test/unit/settingsOps.test.ts` (missing key → `[]`; a list naming a deleted account is
cleaned).

E2E, one case each (new titles in existing flow specs, no new spec file):
- `test/e2e/multi-account.spec.ts` (E1 at `:199`, E3 `:298`, E9 block `:760-818` are the
  neighbours): "a workspace limited to one account starts, restarts past 95% and resumes
  on it, even when another is lighter; with every allowed account walled the banner names
  the workspace and nothing outside the list is used; with the allowed account off the
  shim prints the workspace line". E1's title and its add-entries check change for Add
  endpoint.
- `test/e2e/codex-session.spec.ts` (next to `:432` and `:1674`): the Codex twin.
- `test/e2e/muse-session.spec.ts`, `test/e2e/agy-session.spec.ts` (`:188`): one start each
  on the ticked account.
- `test/e2e/remote-resume.spec.ts` (`:59`) or `remote-workspace.spec.ts`: a remote Claude
  workspace limited to one account starts on it (proves the key rides through
  `launch-<sid>`); `remote-codex.spec.ts:122`, `remote-muse.spec.ts:86`,
  `agy-remote.spec.ts:85`: extend one existing case with the limited account.
- `test/e2e/workspace.spec.ts:137` (`menuItemTexts`): the menu item is there for a
  present workspace and absent for a missing one; a new case: the dialog saves and shows
  the ticks again.

## 8. Not probed yet

- Whether the compiled app CSS equals `styles.css` + the three small view CSS files; the
  mockup embeds those four sources directly **(inferred, not checked)**.
- Whether `claude` resumed on an endpoint takes the re-exported model like a fresh start
  (from the old plan, still not rerun).
- Whether `wsRoot` in `sshHost.ts:1082` is the parent workspace for a resumed remote
  worktree session (see the remote Claude row).
- The remote-Claude plumbing and the tab map are designs, not probes.

## 9. The one question for the owner

**Build it this way — a list per workspace, set from the workspace header's "Accounts…"
dialog, with the behaviour in §1–§5?**

- (a) **Yes, a list per workspace** — recommended. Cost: ten work repositories mean ten
  dialogs, and a new work account is ticked in each.
- (b) **Named groups bound to workspaces instead.** Cost: a second thing to name,
  create, rename and delete, a Settings screen for it, an empty-group rule — and for two
  or three accounts no gain over (a). Can be added later on top of (a).

Decided here, not asked again: the control lives in the workspace menu (old question 1,
skipped twice); Add endpoint is added (old question 0, skipped twice); all-walled starts
on the first to reset inside the list and says so (the owner's comment); a resumed
session outside the list moves inside (the owner's comment); a one-off per-session pick
is not done — separate issue.
