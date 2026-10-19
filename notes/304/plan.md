# #304 — a session that hits its usage limit: the row says "limited until <time>", and Koloft tells you when it goes on

Decided by the owner (option A, 2026-10-15): Claude tabs leave the continue to Claude Code
itself; Koloft only marks the row and notifies. Codex tabs: Koloft types "continue" at the
reset. This plan says how, for every kind of tab, from the code as it is on `main` today.

New fact that shapes the plan (a real transcript on this Mac, Claude Code 2.1.302,
2026-10-18, session `fa34b887…`): the `rate_limit` record itself carries the reset time —
`quotaLimits.resetsAt` (epoch seconds) and `rateLimitType: "five_hour"` — and the transcript
writes a `system`/`informational` line at the hit ("Usage limit reached · continuing
automatically at 2:50pm · esc to cancel") and at the reset ("Usage limit reset · continuing
automatically"), followed by a `user` record `isMeta: true, origin.kind:
"auto-continuation"`. So for Claude tabs the time comes from the transcript, and the clear
comes from the transcript too; the hooks only add the "going on / press Enter / will not go
on" distinction.

## 1. Cases — who does what, what they see

| # | Who does what | What they see |
|---|---|---|
| C1 | A Claude session (local or remote) hits the 5-hour or weekly limit while working. | Its row keeps its title; the light bar turns steady amber (not pumping — pumping means "needs you") and the second line reads `main · limited until 14:05`. No "turn done — your move" red dot, no OS notification, no Discord "finished" card. The tab is not put to sleep while it waits. |
| C2 | The limit resets and Claude Code goes on by itself. | The row goes back to working (accent, breathing); if Koloft is in the background an OS notification says `usage limit over — going on · koloft`; a bound Discord thread gets the same line. Nothing to click. |
| C3 | The Mac slept through the reset; Claude Code did not go on. | Row: `main · limited · press Enter`, a red dot. OS notification `usage limit over — press Enter to go on · koloft`. Clicking it opens the tab; pressing Enter there clears the mark. |
| C4 | Claude Code will not go on by itself (continue turned off, reset more than 24 h away, cap of repeats reached, a Fable-only limit). | Row: `main · limited · will not go on`, a red dot. OS notification `usage limit hit — will not go on by itself · koloft`. |
| C5 | A Codex session (local or remote) hits its limit. | Row: `main · limited until 14:05` (steady amber), time from the app-server's rate-limit frames. At 14:05 + 1 min of slack, if the turn is over and nobody typed or pasted into that tab since the hit, Koloft types `continue` + Enter; the row goes to working and an OS notification says `usage limit over — Koloft typed continue · site`. If the person typed anything after the hit, Koloft types nothing and the mark clears on their next turn. If Codex answers with the limit again, the row shows the new time and Koloft waits and types again, as often as needed. |
| C6 | Settings ▸ Notifications. | One new switch, **Usage limit** ("A session paused on its usage limit went on, or needs you to go on."), on by default — one switch per kind is the pane's pattern (`NotificationsPane.tsx:17-54`, `notifyRouter.ts:10-19`). Off = no OS notification and no Discord line for C2–C5; the row and the red dot stay. |
| C7 | Koloft quits or restarts while a tab is limited. | Claude Code's own continue timer dies with its process, and Koloft's Codex timer is in memory — neither survives. After the restart a Claude row whose transcript still ends on the limit record (no continuation after it) reads `limited · will not go on` with a red dot, since the person has to type to go on; a Codex row comes back as an ordinary resumed session with no mark, and the person types `continue`. Nothing is persisted for this. |

## 2. The eight kinds of tab

| Tab | What it does | Why |
|---|---|---|
| Claude, local | C1–C4, C6, C7 in full; Discord: the "finished" notice and the "turn done" live card are held back while limited, the live card says "limited until 14:05", the four lines of C2–C5 go to the session's thread as a notice card. | The transcript (`sessionTracker.ts:1414 ingestLine`) and the Notification hook (`hooks.ts:454`) both reach Koloft at once; Discord hangs off the same status edge (`index.ts:2644-2647`). |
| Claude, remote (SSH) | The same, one mirror pull late (2 s while the tab works, 5–20 s idle; `remote/sync.ts:34-36`). The machine's hook settings come from the same `hookSettings` (`backends/claude.ts:1076`) and its `hook.sh` is the same `HOOK_SCRIPT` (`index.ts:1040`), so the widened matcher ships by itself; hook lines reach the Mac through the mirror of `.koloft/hook-sessions` (`remote/sync.ts:327-331`, watched by `backends/claude.ts:804`). | Named difference: the lag. `quota_auto_resume_stale` (the Mac slept) will in practice not come from a machine that did not sleep — inferred, not checked. |
| Codex, local | C5–C7 in full; Discord as for Claude. | The observer sees every `turn/completed` (`codexObservation.ts:386`); typing goes through `ptyMgr.type` (`ptyManager.ts:301`, `typeKeys.ts:49 keysFor`). |
| Codex, remote (SSH) | The same. | Only the app-server runs on the machine; the TUI runs on this Mac with `--remote` against a `codex app-server proxy` over ssh (ADR-0039, `codexSessions.ts:790`, `remote/codexMachine.ts:152-157` ends in `exec <tui>` locally, `:229-233` the proxy). So the pty Koloft types into is local, and the same `CodexObservation` (`codexSessions.ts:709`) reads the same frames. The limit frames come from the machine's server, signed in with the Mac account's token. |
| Muse, local / remote | Left out. | Koloft can read a Muse account's reset times by typing `/usage` into a hidden muse (`museQuota.ts:63`), but what a live session shows or writes when it hits the limit is not probed (the MUSE ledger has no entry). Nothing to key a mark on. |
| Antigravity, local / remote | Left out. | AGY§22 measured it: a 429 is retried 8 times (4–27 s gaps) and the session ends in OSC 7501 `error` after ~140 s with the 429 text on screen — no reset time anywhere, no continue-at-reset. The row already shows that error state today; "limited until" needs a time agy does not give. |

## 3. How it works

### Claude: the hit
- `TranscriptRecord` (`transcriptRecord.ts:46`) gains `isApiErrorMessage`, `error`, `apiError`,
  `quotaLimits?: { resetsAt?: number; rateLimitType?: string }`, `origin.kind` is already there.
- `ingestLine` (`sessionTracker.ts:1414`) checks an `assistant` record for
  `isApiErrorMessage && error === 'rate_limit'` **before** the `activity = 'assistant'` branch
  (`:1494`) and before `meter.add` (`:1490`; the record's model is `<synthetic>`, which the
  meter already skips, `usageMeter.ts:34`). It sets `info.limited = { until?: number, how:
  'auto' | 'koloft' | 'stuck' }` on the shared `BackendSessionInfo` (`types.ts:714`), `until`
  from `quotaLimits.resetsAt`. A record with `apiError: 'model_requires_usage_credits'` (the
  Fable-only limit, seen on 2.1.278: no `quotaLimits`, Claude does not go on by itself) sets
  `how: 'stuck'` with no time → C4 straight away.
- **No `quotaLimits.resetsAt` on an ordinary limit** (not probed whether 2.1.293, the minimum
  Koloft runs, `cliMinimums.ts:2`, writes it): the row says `limited` and `until` is filled
  from what Koloft already knows about the tab's account — `info.account` (the hook's
  `ANT_ACCOUNT`, `hooks.ts:214`) → `usageViews` (`index.ts:1133`, keyed `kind:name`) → the
  bucket whose `windowTone` (`accountUsage.ts:103`) is `hard`/`soon` → `r5`/`r7`; with no
  snapshot, one probe of that account (the `probeAccount` call at `index.ts:1798`) fills it.
  The status line's `rate_limits.*.resets_at` (CC§6, `docs/claude-code-contract.md:769-774`)
  is "not yet seen live" and Koloft never parses that JSON, so it is not used.
- The status edge still fires (Stop at the hit is inferred, not checked: the transcript writes
  its turn-end record `turn_duration` 7 ms after the limit record; the hook log has no
  timestamps). In `tracker.on('status')` (`index.ts:2638-2650`) a `limited(tabId)` check
  holds back both `discordNotices.onStatus` (`:2644`, else `notices.ts:29` sends "🔔
  finished") and `attention.onStatusChange` (`:2647`, else a turn-done mark and OS
  notification); `discordLive.refresh` (`:2645`) runs and draws the limited state. Harmless if
  Stop does not fire.
- A limited tab counts as held in `tracker.heldTabs` (`index.ts:620`). Today a limited session
  stays awake only because Stop leaves a turn-done mark and `tryAutoClose`
  (`sessionRuntime.ts:200-218`) holds tabs with a pending mark (`needsUser`, `index.ts:628`);
  this plan removes that mark, so the hold has to come from the limit itself — otherwise
  `sleepTab` (`index.ts:766`) would end the process ~34 min later and the continue never
  happens.

### Claude: the clear and the three notices
- The clear comes from the transcript: a `user` record with `origin.kind ===
  'auto-continuation'` is handled **before** the `isMeta` skip at `sessionTracker.ts:1458`
  (today every `isMeta` user record is ignored) and counts as `activity = 'user'` → the row
  goes working and `info.limited` clears. Should that record ever be missing, the assistant
  record that follows it flips the row through the measured `resumeWorkingIfStale` path
  (`:1352-1369`, `RESUME_AFTER_STOP_MS` `:41`). Any new prompt or assistant record also
  clears the mark.
- The hook matcher (`hooks.ts:424-430`, used at `:456`) gains
  `quota_auto_resume_fired|quota_auto_resume_stale|quota_auto_resume_disabled` and is renamed
  from `NOTIFICATIONS_WAITING_ON_THE_PERSON` to `NOTIFICATIONS_KOLOFT_LISTENS_TO`; the script's
  `notify` branch (`hooks.ts:257-321`) writes `notification_type` into the status line next to
  `message`.
- `sessionEventFromHook` (`sessionTracker.ts:93-98`) branches on `notification_type`
  **before** its "permission/approval → else input" guess — today a quota message would
  read as `need: 'input'`, and `turnOf` (`sessionRuntime.ts:17`) would make the row pump
  amber as "needs approval". The three types become a new `SessionEvent` `{ type: 'limit',
  phase: 'fired' | 'stale' | 'disabled' }` that `turnOf` returns `undefined` for.
- `fired` → clear the mark; OS notification only, no pending mark. It cannot go through
  `showOsNotification` (`index.ts:925-941`): that registers the banner in `osNotifications`,
  and `retractStaleOsNotifications` (`:897-906`, run on every attention change, `:676`)
  closes any banner whose tab has no pending mark — which is this one. So a small helper
  takes `route()`'s decision (`notifyRouter.ts:26`: window unfocused, switch on) and then
  `osNotification(text).show()` without registering (`notifyPlain`, `:943`, skips the
  decision, so it is not reused as is). The same helper sends the Discord notice card.
- `stale` / `disabled` → `info.limited.how = 'stuck'`, and a pending mark of the new kind
  `'limit'` is raised (`AttentionKind`, `types.ts:633`; `ATTENTION_REASON` `:652` gets a
  `limit` entry, it is a `Record<AttentionKind, string>`; `categoryEnabled`,
  `notifyRouter.ts:10`, reads the new `notifyLimit` setting). The event carries its own
  `reason` text, since the two messages differ: `osNotificationText` (`index.ts:908`) and the
  row's red-dot tooltip (`WorkspaceSidebar.tsx:1217`) read `event.reason ??
  ATTENTION_REASON[kind]`. `consumeOutletDedupe` (`index.ts:950`) lists kinds by name and
  gains `limit`. A `'limit'` mark saved across a Koloft restart comes back as `turn-done`,
  like a dead `approval` (`attention.ts:29-31`): the process is gone, Enter would do nothing.
  Working clears the mark and the pending `'limit'` mark (`attention.ts:48-51`, as now).

### Codex
- `turn/completed` (`codexObservation.ts:386-403`) reads `turn.error` (shape inferred, not
  checked — the 0.162.0 binary names the kind `usageLimitExceeded` next to
  `rateLimitExceeded`, and the fake's turns already carry an `error: null` field,
  `fake-codex.js:242`). On `error.kind === 'usageLimitExceeded'` it emits `{ type: 'limit',
  phase: 'hit' }` **before** `publishActivity()`, and the turn then ends normally: `mainTurn =
  'ended'` → `TURN_EVENT['ended']` (`:651-653`) → `recordTurn` → the status edge, all in one
  synchronous chain (`thread/status/changed`, `:506-522`, sets `ended` the same way). The
  turn has to end: Koloft only types when `runtime.turnOver(tabId)` (`sessionRuntime.ts:78-81`,
  true for `ended`/`input` only).
- `StoredSessions.observe` (`storedSessions.ts:656`) on `limit/hit` sets `info.limited = {
  how: 'koloft' }` **synchronously**, so the `limited(tabId)` gate at `index.ts:2646` already
  holds when the edge arrives a few calls later; `until` is filled afterwards.
- The time: the observer adds `account/rateLimits/updated` to `SERVER_METHODS_OBSERVED`
  (`codexObservation.ts:133-142`; the relay already passes these frames, CODEX§15,
  `docs/codex-cli-contract.md:813-814`, and today ignores them) and keeps the latest
  `rateLimits` per thread → `codexBackAt` (`accountUsage.ts:166`). Whether a failed turn
  also pushes an `updated` frame is not probed; when none has arrived, `readAccount(home)`
  (`codexSessions.ts:476-481`, `account/rateLimits/read`) is the fallback. With no number at
  all the row says `limited` and Koloft types nothing.
- A timer at `until + 60 s` (a named constant; test knob `KOLOFT_LIMIT_SLACK_MS` through
  `envMs`): type only if the tab is alive, `runtime.turnOver(tabId)`, no `turn/started` since
  the hit, and no text from the person reached the tab since the hit. "The person typed" is
  stamped where their text enters the pty: the `CH.terminal.write` handler (`index.ts:4912`)
  **and** the `CH.terminal.paste` handler (`:4913`, a paste lands text too). Then
  `ptyMgr.type(tabId, keysFor(['continue', 'enter']))`, clear the mark, "Koloft typed
  continue" through the helper above. Any keystroke or paste from the person cancels the
  plan: their unsent composer text must not go out with a "continue" glued on.
- The limited tab is held from sleep like a Claude one. If the typed turn fails with
  `usageLimitExceeded` again: a new mark with the new time, a new timer, no cap — on a walled
  account that is one cheap failed turn per window.

### Discord
- `noticeKindOf` (`discord/notices.ts:23-31`) gains a kind `'limit'`, sent through
  `noticeCard` (`:47`) to the session's thread with the same four body lines as the OS
  notifications, under the same bindings rule as "finished".
- `liveStateOf` (`discord/liveStatus.ts:43`) gains a `limited` state drawn as `⏳ limited
  until 14:05` (amber accent, `0xf0a830`) while `info.limited` is set, in place of "✅ turn
  done".

### The row
- `rowStateClass` (`sessionRows.ts:108`) is unchanged; `SessionRowView`
  (`WorkspaceSidebar.tsx:240`) appends ` limited` to the class and renders the text inside
  the existing last `.ws-tab-sub` span, after the worktree name: `<span>main · <b
  class="ws-tab-limit">limited until 14:05</b></span>`, so the ellipsis rule `.ws-tab-sub >
  span:last-child` (`styles.css:1046`) still applies to one span. Time through `resetLabel`
  (`accountMeter.tsx:13`, the capsule's own `HH:MM` / `M-D HH:MM`).
- The conductor rows (`ConductorsIsland.tsx:145-147`) take the same ` limited` class, so
  their bar matches; they have no second line, so no text.
- CSS: `.ws-tab.limited::before { background: var(--amber); opacity: 0.55; animation: none }`
  is a new member of the bar vocabulary, a sibling of `.ws-tab.st-idle::before`
  (`styles.css:956-960`), placed **after** the `.ws-tab.st-*::before` rules (`:910-969`),
  since it ties them on specificity; plus `.ws-tab-limit { color: var(--amber) }`. `limited`
  only ever sits next to `st-waiting`/`st-idle`/`st-working` (a limited session is not on a
  permission dialog), so `st-approval`'s width and transform need no reset. Steady amber
  reads apart from pumping amber (approval) and from green (waiting).
- A limited row gets the `tooltip` prop (`WorkspaceSidebar.tsx:1206`, cold rows only today):
  `Usage limit hit · Claude Code goes on by itself at 14:05` / `Usage limit hit · Koloft types
  continue at 15:20` / `Usage limit over · press Enter in the session to go on` / `Usage limit
  hit · Claude Code will not go on by itself`. The mockup `index.html` shows all of this next
  to the normal rows.

### Notifications
| When | Title / body (body ends `· <folder>` as today, `index.ts:908`) | Mark on the row |
|---|---|---|
| Claude `quota_auto_resume_fired` | `<session title>` / `usage limit over — going on` | none (clears) |
| Claude `quota_auto_resume_stale` | `<session title>` / `usage limit over — press Enter to go on` | red dot, `limited · press Enter` |
| Claude `quota_auto_resume_disabled`, or a Fable-only limit record | `<session title>` / `usage limit hit — will not go on by itself` | red dot, `limited · will not go on` |
| Codex, Koloft typed continue | `<session title>` / `usage limit over — Koloft typed continue` | none (clears) |
| Any tab at the hit | no notification (the owner's pick: notify when it goes on) | steady amber, `limited until <time>` |

All four go through `route` (`notifyRouter.ts:26`): only while the window is unfocused, only
with the **Usage limit** switch on, never a beep; the same decision sends the Discord card.

## 4. After the upgrade (an existing user)
- The new setting defaults on (`types.ts:454`; an old `settings.json` without the key reads
  as on, because `sanitizeLoadedSettings` spreads the file over `DEFAULT_SETTINGS`,
  `settingsOps.ts:69`). Nothing else to migrate.
- A Claude session already running keeps its old hook settings file (written per launch,
  `hooks.ts:548`), so until it is restarted it gets the mark and the clear from the transcript
  (C1, C2 without the OS note), but not C3/C4. A session started after the upgrade gets all
  of it. Sessions, workspaces, accounts, Discord bindings: untouched.

## 5. Tests
Unit (`npm run test:unit:changed`), which existing ones go red and what is new:
- `hooks.test.ts:1121` "a Notification reaches Koloft only when claude stops to wait on the
  person, never for a mid-turn one" — the rule changes: the three quota types are mid-turn by
  that test's own definition and now pass; retitle it "…or when a usage limit pauses or
  resumes it". `hooks.test.ts:413` gains the `notification_type` field.
- `sessionTracker.test.ts`: new — the `rate_limit` record marks the row limited with the
  record's time, counts as neither activity nor usage; the `auto-continuation` record clears
  it although it is `isMeta`; a Fable-only record marks it stuck with no time; a record
  without `quotaLimits` takes the account snapshot's reset.
- `attention.test.ts`: new — stale/disabled raise `'limit'`; working clears it;
  `attention.test.ts:134` (a saved approval comes back as turn-done) gets the parallel
  `limit` case. The swallow of the status edge is main's gate, covered by the e2e below.
- `notifyRouter.test.ts:32` (a disabled category) gains the new switch.
  `sessionRows.test.ts` component case for the `.ws-tab-sub` text and the ` limited` class.
- `codexObservation.test.ts:267` ("notifies once per live turn that ends…") gains the
  failed turn: `limit/hit` first, then the turn ends; and the `rateLimits/updated` frame kept
  per thread. `codexSessions.test.ts`: new — types `continue` only when the turn is over,
  untouched and past the time; not after a keystroke or a paste; again after a second limit.
- `discord/notices.test.ts` / `liveStatus.test.ts` (whatever exists there): the `limit`
  notice card and the limited live state.

E2E (`test/e2e`, picked by flow name, then by the identifiers touched: `.ws-tab`,
`osOutlets`, `CH.terminal.write`, `CH.terminal.paste`, `Notification`, `noticeCard`):
- `attention.spec.ts` (marks from real status transitions): C1 + C2 with fake-claude's new
  typed line `/limit <seconds>` — appends the limit record (`quotaLimits.resetsAt = now +
  seconds`) and the informational line, fires Stop, and after `<seconds>` appends the reset
  line, the `auto-continuation` user record, fires UserPromptSubmit and a Notification
  `{message, notification_type: 'quota_auto_resume_fired'}` (fake-claude's `fireHook`,
  `fake-claude.js:287`, calls the command straight, so it must send the type itself), then a
  reply and Stop. Asserts: `.ws-tab.limited` with the time, no `turn-done` in
  `pendingAttention`, then working.
- `attention-outlets.spec.ts`: the three Claude texts and the Codex text through `osOutlets`
  (`helpers/app.ts:80`), and that the "going on" banner is recorded although no mark is
  pending; `/limit-stale` and `/limit-disabled` lines fire the other two types.
- `idle-auto-close.spec.ts`: a limited tab is not put to sleep past the idle close.
- `remote-workspace.spec.ts` (E-RW-xx): the mark and its clear arrive through the mirror on a
  remote Claude tab (fake-claude runs on the fake machine, `helpers/remote.ts`).
- `codex-session.spec.ts`: fake-codex gains a flag file `fake-codex-limit-until` (epoch
  seconds; `fake-codex.js` reads such files per method, `:412`): the next `turn/start` ends
  in `turn/completed` with `status: 'failed', error: { kind: 'usageLimitExceeded', message }`
  after an `account/rateLimits/updated` frame with `usedPercent: 100, resetsAt: <that
  time>`, and `account/rateLimits/read` (`fake-codex.js:545`) answers the same while the
  file exists; the fake deletes the file when the time passes. Cases: continue typed at the
  time (`KOLOFT_LIMIT_SLACK_MS=0`), the row working again, the OS text, no turn-done dot at
  the hit; not typed when the person typed into the tab first; not typed after a paste from
  the Changes ✎ comment (`:1884` already pastes that way); a second failure shows the new
  time and types again.
- `remote-codex.spec.ts` (E-RC-xx): the local case over the machine proxy
  (`installCodexOnFakeRemote`).
- `discord-flow.spec.ts`: no "finished" card at the hit, the limit card at the reset.
- `settings.spec.ts` and `upgrade-continuity.spec.ts` have no notify-toggle cases today:
  new — the switch turns the four banners off; an old settings file reads the switch as on.

## 6. Ledger facts the build PR adds
- `docs/claude-code-contract.md` §2 (Transcript on disk): the limit record — `type:
  assistant`, `isApiErrorMessage: true`, `error: "rate_limit"`, `apiErrorStatus: 429`,
  `apiError: "usage_limit_reached"`, `quotaLimits: {status: "rejected", resetsAt: <epoch s>,
  rateLimitType: "five_hour", overageStatus, …}`, `message.model: "<synthetic>"`, text
  "You've hit your session limit · resets 2:50pm (America/Los_Angeles)"; the two
  `system`/`informational` lines; the reset's `queue-operation enqueue` and the `user` record
  `isMeta: true, origin.kind: "auto-continuation", turnOrigin: "auto_continuation"` (one real
  transcript, CC 2.1.302, 2026-10-18). For contrast the 2.1.278 Fable-only record: `apiError:
  "model_requires_usage_credits"`, `errorDetails` with the 429 body, no `quotaLimits`.
- §8, next to the Notification type list at line 1017-1030 (the issue says "CC§4", but §4
  is "Worktree session exit"; the Notification vocabulary lives in §8): the three
  `quota_auto_resume_*` payloads are `{message, notification_type}` only, no reset time, and
  nothing fires at the hit (`strings`, 2.1.303, 2026-10-19), with the three message texts.
- `docs/codex-cli-contract.md` §15 (next to `rateLimitReachedType`): the turn-failure kinds
  `usageLimitExceeded` / `rateLimitExceeded`, the text "You've hit your usage limit… Try
  again at <time>", the model fallback lines, and that no continue-at-reset exists (`strings`,
  0.162.0, 2026-10-19); the live frame shape is not probed.

## 7. Inferred, not checked — and the probes the build PR runs
1. Stop fires when the limit hits (turn-end record 7 ms after the limit record; no timestamped hook log). Probe: hand-test sandbox or the Docker lab with hooks logging and a limited account.
2. `quotaLimits.resetsAt` is on every `usage_limit_reached` record, the weekly one too, and on 2.1.293 (one record seen, `five_hour`, 2.1.302).
3. The Codex `turn/completed` frame for a limit carries `turn.error.kind`, and whether a failed turn also pushes `account/rateLimits/updated` (binary strings only; no account was at its limit).
4. `quota_auto_resume_stale` does not come from a remote machine (it is about the Mac sleeping).
5. Typing `continue` + Enter into an empty Codex composer sends exactly that (CODEX§25 keys; `koloft session send` types other text this way today).
6. Low priority: whether the 60 s `idle_prompt` Notification (CC§8, `:1025`) fires while Claude Code sits armed at the limit — today it maps to `need: 'input'` → the row would pump amber as "needs approval" (`sessionTracker.ts:93-98`); if it does fire, a limited tab ignores it.

## 8. Question for the owner
**Build it this way?** Everything above is decided in the plan (the switch is its own row,
Koloft retypes `continue` after every new time, Discord gets the same four lines, nothing
survives a restart). The one real product choice left: whether Koloft types `continue` for
Codex at all, or only marks and notifies like it does for Claude (then C5 ends at the mark
and a "press Enter to go on" style note at the reset; cost: the person comes back to every
limited Codex session, as the owner chose not to on 2026-10-13). Recommended: yes, as
planned.
