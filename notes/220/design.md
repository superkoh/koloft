# #220 — Search the text of every conversation

Issue #220 (a GitHub issue, a request): "Search the text of every Claude and Codex
conversation in the workspace(s) and open the hit."

Paths below are repo-relative, on today's `main`. "CC§2" means section 2 of
`docs/claude-code-contract.md`; "CODEX§19" means section 19 of
`docs/codex-cli-contract.md`.

## 1. What the user sees

- **Edit ▸ Search Sessions (⌥⌘F)** opens a small dialog, built like the Restore dialog
  (C9): a header "Search sessions", one input box, a list of rows.
- You type a word or phrase and press ⏎ (Enter). Koloft looks through every
  conversation of every pinned workspace — Claude Code and Codex, local and over ssh —
  and lists the sessions where that text appears, newest first.
- Each row shows: the session's title; one line of the text around the match, with the
  match in the accent colour; and under it the backend icon (Claude / Codex) — always
  shown here, since hits span workspaces and backends, unlike C9 which shows it only
  when one workspace mixes backends (`RestoreDialog.tsx:64`) — the workspace name, the
  worktree, and "running" or how long ago it was last touched.
- Click a row: a session that is running switches to its tab; a cold session resumes
  (exactly what clicking it in the sidebar does); a session that was removed from the
  list comes back and resumes (exactly what the Restore dialog does). The dialog closes.
- Esc or the × closes the dialog. While Koloft searches, the line under the box says
  "Searching…"; afterwards it says how many sessions matched ("4 sessions") or "No
  matches". Pressing ⏎ again searches again.
- The sidebar never changes while you search — the board stays the board.

Mockup: `index.html` next to this file (today's Restore dialog on the left, the new
dialog on the right, same app chrome, the app's own compiled stylesheet; `mockup.png` is
its headless render). The fourth hit is cut off on purpose: `.restore-list` is capped at
190px and scrolls (`src/renderer/src/styles.css:2133`), the app's own rule, kept as is.

## 2. Where it lives in the UI, and why not elsewhere

| Place | Verdict |
| --- | --- |
| Its own dialog, C9's classes (`.modal.restoresess`, `.restore-list`, `.restore-row`, `.restore-title`, `.restore-meta`), input `.find-input` | **Chosen.** No new screen, no new row kind. One new class for the snippet line (`.restore-snippet`) because no existing class carries a second text line under a title, and one width rule so the input fills the dialog (§5). |
| The Workbench find bar (`FindBar.tsx`, ⌘F) | No: it finds inside one tab's DOM; `.find-bar` is `position:absolute` inside `.wb-panel` (`styles.css:2487`). |
| The Files-tab search (⇧⌘F, `.ft-search`) | No: it is the session's file search; same key, different meaning would confuse. |
| A filter row above the sidebar list (like `.ft-search`) | No: while you type, rows without a hit vanish — including `st-waiting` / `st-approval` rows, the live board the roadmap says must stay visible (`attention-outlets.spec.ts` pins "no roll-up"). Option 2 in §9. |
| The command palette (#6) | Not built, and itself waiting on an owner decision. When it comes it can absorb this dialog's list unchanged (same rows, same click). Option 3 in §9. |

Key: ⌥⌘F is free (menu accelerators in `src/main/menu.ts`; the pane list in
`ShortcutsPane.tsx:14–233`). The menu item is always enabled, like Search Files
(`menu.test.ts:454` pins which four items may grey out): with no workspace pinned the
dialog opens and every search says "No matches". `menu.test.ts:528` fails until the
Shortcuts pane lists ⌥⌘F, so the pane's **Sessions & workspaces** group
(`ShortcutsPane.tsx:10–81`, beside ⌥⌘N Note) gets a row "Search sessions · Lists every
session whose conversation holds the words · No workspace: No matches."

## 3. What is searched, and how

**The rule, the same for all four tab kinds:** a case-insensitive literal substring in
what the person typed and what the model answered. That wording is Codex's own, from the
`thread/searchOccurrences` schema ("case-insensitive literal substring … in visible user
messages and final assistant messages"); that `thread/search` — the call this design uses
— matches the same text is **inferred from that description, not checked** (its own
schema only says "substring/full-text query", §7, §8). Koloft's Claude reader follows
that rule exactly, so a mismatch can only come from Codex's side. Not tool output, not
tool calls, not thinking, not Koloft's own `isMeta` records. A session's **title** counts
too (so the box also finds a session by name) — on both backends, from the row's own
title, so it never depends on what `thread/search` indexes.

**Why not tool output:** it is most of the bytes (in the measured corpus of §7, tool
results are about 80% of each file; real `tasks/` and `memory/` subfolders add more), it
is noise ("the one where we fixed X" is said in words, not in a `grep` result), and it
keeps Claude's rule equal to Codex's.

**Where:** main process, one streaming pass, on ⏎ — never per keystroke (a search over
500 MB costs about half a second, §7).

```
renderer                      main
Search dialog ─⏎─► sessions:search(term) ─► SessionBackends.search(term)
                                              ├─ claude: WorkspaceManager.searchRows(term)
                                              │     every Claude row of every pinned workspace,
                                              │     local root or the ssh mirror root,
                                              │     stream <slug>/<id>.jsonl, stop at 1st hit
                                              └─ codex:  CodexSessions.search(term)
                                                    thread/search per CODEX_HOME,
                                                    keep threads whose workspace is pinned
                  ◄── SessionSearchHit[] { row, workspacePath, snippet }  (mtime desc)
```

Claude, per row: `transcriptSearch.ts` reads the file with `readline` over
`fs.createReadStream`; a line is parsed only if `line.toLowerCase().includes(term)`;
then `type` must be `user` or `assistant`, `isMeta` not true, and the text is
`message.content` when it is a string, else **every** `text` block joined — not the
first-block pick `extractJsonlMeta` makes for a title (`sessionAggregate.ts:148–156`),
since a reply with several text blocks must match on any of them. First hit → a snippet
of ~60 characters each side → stop reading that file. Eight files at a time; a newer
search cancels the old one (the dialog shows only the latest).

Rows come from what the sidebar and C9 already know, never a raw folder walk:
`allRowsCache` (`workspaces.ts:677`) holds every row per workspace — members and cold
history alike. For a local workspace it also holds the Codex rows merged in at
`workspaces.ts:679–689`, so the Claude pass keeps only `backendId === 'claude'`; Codex
rows are the Codex pass's job. The file for a row: `statByFile` (`workspaces.ts:191`,
filled at `:904`) already keys every transcript's full path, but by path, not by id, and
it also holds files of unpinned slugs; so the rescan loop at `:658–669`, which has
`root`, `slug` and `id` in hand, records `transcriptFileById` beside `bucketDirById`
(which holds the checkout dir, not the slug dir). Rows the sidebar hides (`hiddenRow`,
conductor sessions via `conductorOf`) are skipped the way `historyRows` skips them
(`sessionBackends.ts:178`).

Codex, per home: `thread/search { searchTerm, limit: 100, cursor, archived: false,
sourceKinds: ['cli','vscode','appServer'] }` paged like `listHome`
(`codexSessions.ts:486–520`); each hit's `thread` goes through `userThread`; its
workspace is found the way `rows()` does it — the member's saved `workspacePath` first,
else `workspaceFor(thread.cwd)` (`codexSessions.ts:350`) — and kept only when that is a
pinned workspace; the row is built by `row(thread, scope)` (`:399`) so title and worktree
match the sidebar; `snippet` is Codex's own. A Codex row whose title holds the term but
whose text `thread/search` did not return is added from `this.history` (the same map
`rows()` reads), so the title rule holds on both backends. `thread/search` must be added
to the allow-list at `codexTransport.ts:532–540`. Reading rollout files on disk instead
was rejected: CODEX§19 says history is moving to paginated storage and `includeTurns` is
deprecated.

## 4. The four tab kinds

| Tab kind | Text read from | A hit opens by | Named difference |
| --- | --- | --- | --- |
| Claude Code, local | `~/.claude/projects/<slug>/<id>.jsonl` (CC§2) — the same file for a live session, since the transcript is append-only | running → its tab; cold → resume; removed → restore (`resumeSession({restore: true})`, as `RestoreDialog`) | none |
| Claude Code, remote (ssh) | the mirror `userData/remote/<host>/projects/<slug>/<id>.jsonl` (`remote/paths.ts:8`), rsync'd whole (`remote/sync.ts:7–23` includes `*.jsonl`) | the same — and a row that is running on the machine with no tab here (`isOrphanRow` + remote host) goes to `resumeSession(row)`, which attaches to the tmux session, copied from the sidebar's own branch (`WorkspaceSidebar.tsx:405–408`) | (1) only the slugs of pinned remote paths are mirrored (`projectFlags`), so nothing beyond the sidebar's rows is searchable — same scope as local; (2) text is one pull late: 2 s with tabs open, 20 s idle (`sync.ts:28–29`) |
| Codex, local | the app-server's `thread/search`, per `CODEX_HOME` (default plus every account home, `deps.homes()`); titles from Koloft's own history map | running → its tab; cold → `resume` | archived threads are not searched (they cannot be resumed, CODEX§2); the snippet is Codex's, so its length and cut differ from Claude's |
| Codex, remote (ssh) | — | — | left out: no such tab runs (#99, CODEX§16) |

## 5. Code it touches (rough size, runtime lines under `src/`)

| File | Change | ≈ lines |
| --- | --- | --- |
| `src/main/transcriptSearch.ts` (new) | `searchTranscript(file, term, signal)` → snippet or null; `snippetAround(text, at)` | +60 |
| `src/main/workspaces.ts` | a `transcriptFileById` map filled at :666; `searchRows(term, signal)` over `layout.workspaces × allRowsCache`, Claude rows only, skipping `hidden()`; title match counts | +45 |
| `src/main/codexSessions.ts` | `search(term, pinned)` beside `listHome` (:486); hits → member-first workspace (:350) + `row(thread, scope)` (:399) + snippet; title matches from `this.history` | +45 |
| `src/main/codexTransport.ts:532` | `'thread/search'` in the allow-list | +1 |
| `src/main/sessionBackends.ts:26` | `search(term)` on `SessionBackend`; `SessionBackends.search(term, partlyUnread)` like `historyRows` (:161) — merge, drop `conductorOf`, sort by mtime | +30 |
| `src/main/backends/claude.ts:140`, `backends/codex.ts:21` | the adapter methods | +8 |
| `src/main/index.ts:3531` | `ipcMain.handle('sessions:search')`, cancelling the previous search; `'shortcut:search-sessions'` already flows through `sendToRenderer(`shortcut:${action}`)` (:1955) | +15 |
| `src/main/menu.ts:137` | Edit ▸ Search Sessions, id `search-sessions`, `accelerator: isMac ? 'Alt+CmdOrCtrl+F' : undefined` like its two Edit-menu siblings (:134, :140), always enabled | +6 |
| `src/preload/index.ts:508`, `src/shared/types.ts:1005` | `sessions.search(term)`, `shortcuts.onSearchSessions`, `SessionSearchHit` | +15 |
| `src/renderer/src/components/SearchSessionsDialog.tsx` (new) | the dialog: `.modal.restoresess` + `.find-input` + `.restore-list`; Esc closes (same hook as `RestoreDialog.tsx:33`); the backend icon on every row | +110 |
| `src/renderer/src/sessionRows.ts` | `liveTabIdFor(sessions, tabs, id)` moved out of `WorkspaceSidebar.tsx:229–231` so the dialog and the sidebar share one "which tab is this row's" | +8 / −3 |
| `src/renderer/src/App.tsx:617–1632` | state `searchOpen`; `onSearchSessions` listener beside `onFindFiles` (:621); `openHit(hit)`: listed + live tab → `attention.visit` + `activateTab`; listed + running on a remote machine with no tab (`isOrphanRow`, remote host) → `resumeSession(row)`; listed + cold → `resumeSession(row)`; not listed → `resumeSession({..., restore: true})`; mounted in the portal beside `RestoreDialog` (:1617) | +40 |
| `src/renderer/src/styles.css:2176` | `.restore-snippet` (mono 10.5px, `--fg-dim`, one line, ellipsis), `.restore-snippet b { color: var(--accent) }`, and `.restoresess .find-input { width: 100% }` (the bar's own rule is 180px, `:2501`) | +15 |
| `src/renderer/src/components/settings/ShortcutsPane.tsx:68` | the ⌥⌘F row in Sessions & workspaces | +8 |

Total ≈ +400 runtime lines. No ADR: everything is readable from names and tests. One
ledger entry, CODEX§22, for what §7 measured about `thread/search`, cited with
`// CODEX§22` at the Codex search site and the allow-list line.

One sidebar behaviour the dialog does **not** copy: a *local* running row whose tab was
lost (`isOrphanRow`, no remote host) gets a "force close?" dialog from the sidebar
(`WorkspaceSidebar.tsx:409–411`); from the search dialog it goes through
`resumeSession`, whose plan answers "still running" as a toast. Rare, and the sidebar row
is one click away.

## 6. Tests

Existing tests that change:

- `test/unit/menu.test.ts:528` — "lists every accelerator the native menu binds": goes
  red until `ShortcutsPane` lists ⌥⌘F. `:454` ("only the four gated items grey out")
  must stay green: the new item never greys.
- `test/unit/workspaces.test.ts`, `codexSessions.test.ts`, `sessionBackends.test.ts` —
  one case each for the new method (rows found, hidden rows skipped, Codex rows left to
  the Codex pass, unpinned cwd dropped, one backend failing still returns the other's
  hits). `codexTransport.test.ts` does not pin the allow-list (it only checks that
  `turn/start` is refused, `:106`), so it does not change.

New:

- `test/unit/transcriptSearch.test.ts` — the rule: finds the term in a user string, in
  an assistant `text` block, and in a second `text` block of one record; ignores
  `tool_result`, `tool_use` and `isMeta` lines; case-insensitive; one snippet per file;
  stops after the first hit (reads no further lines).
- `test/e2e/session-search.spec.ts` (flow name; the four kinds):
  1. local Claude — `seedJsonl` two sessions in ws-a with different `summary` texts (the
     seeder writes it as the user prompt, `helpers/p1.ts:214–219`); `clickAppMenuItem(app,
     page, 'search-sessions')`; type, ⏎; the matching row shows its snippet; click → a
     tab resumes with that id (`env.claudeCalls`).
  2. a live row — `startSessionIn`, type `/answer needle`, wait for Stop; search →
     click → the existing tab is active, no new launch.
  3. a removed row — `Remove from list`, search → hit → click → row is back and resumed
     (what `bb-c8…restore.spec.ts` BB-M09 checks for C9).
  4. local Codex — `installCodex`; `fixtures/fake-codex.js` learns `thread/search`
     (≈15 lines next to `thread/list` at :249: filter its saved threads by preview text,
     answer `{data: [{thread, snippet}], nextCursor: null}`); search → hit with the
     Codex icon → click → `codex resume <id>` in `fake-codex-calls.jsonl`.
  5. remote Claude — `seedJsonl(env, dir, { root: path.dirname(mirrorProjectDir(env)) })`
     as `conductor.spec.ts:363` does; search → hit shows the host's workspace → click →
     resume over the fake ssh (`remote-resume.spec.ts`'s path); a second case with the
     fake tmux reporting the session alive → click attaches instead of starting.
  Remote Codex: no case — no such tab.

## 7. What was measured (2026-10-07, on a scratch corpus and test homes only)

- **Cost of the Claude side.** 420 fake transcripts, 504 MB, 307,441 lines (about
  1.6 KB per line, user/assistant/tool_result records, tool results ≈ 80% of the bytes),
  in a scratch folder: streaming line scan with the `includes` prefilter — 737 ms on the
  first run, 427 ms with a term that never matches (cache warm); reading whole files
  instead — 365 ms. (`gen-fake.mjs`, `search-time.mjs` in this folder.) So: search on ⏎,
  no index.
- **Codex `thread/search` exists and answers**, Codex CLI 0.159.3: the schema from
  `codex app-server generate-json-schema --experimental` names `thread/search`
  (`searchTerm`, `cursor`, `limit`, `archived`, `sourceKinds`, `sortKey`) →
  `{ data: [{ snippet, thread }], nextCursor, backwardsCursor }`, and
  `thread/searchOccurrences` ("case-insensitive literal substring … in visible user
  messages and final assistant messages"). Against a fresh, empty test `CODEX_HOME`,
  `codex app-server --stdio` answered `thread/search` with `{data: [], nextCursor:
  null, backwardsCursor: null}` in 2 ms, and `thread/searchOccurrences` with `-32601
  "not supported yet"` on a legacy-mode home and `{data: []}` on a paginated one — the
  latter is not used by this design. No real home was used for numbers.
- **Two synthetic rollouts were not listed by the app-server.** Two hand-written
  rollout files (keys copied from a real one's shape — `session_meta`,
  `response_item/message`, `event_msg/item_completed` — the identity, window and
  retained-source values not copied), one `history_mode: legacy`, one `paginated`, in a
  test `CODEX_HOME`: `thread/list` listed neither. Which missing field hides them was not
  probed. Probe: `codex migrate-rollouts --apply` on the legacy home reported it
  "migrated" (5,186 bytes) and `thread/list` still showed 0 — so "legacy rollout →
  paginated → listed" is not one step. The e2e Codex case therefore has the fake-codex
  fixture answer `thread/search` itself (§6), for the same reason it already answers
  `thread/list`: Koloft reaches Codex history only through the app-server, never through
  files.
- Codex rollout record shape (keys only): top level `timestamp, ordinal, type, payload,
  metadata`; `type` ∈ `session_meta, event_msg, response_item, world_state,
  turn_context, token_usage_record`; user text in `response_item/message`
  `content[].type = input_text`, model text `output_text` with `phase`; `history_mode`
  `paginated` on 0.159.3.

## 8. Inferred, not checked

- Which item kinds `thread/search` matches (user + final assistant text, like
  `searchOccurrences` says) — only `searchOccurrences`' description states it; the
  `thread/search` schema says "substring/full-text query". That it returns any hit at
  all for a thread whose text holds the term was not shown on a test home (the synthetic
  threads were not listed, §7).
- That `thread/search` returns one hit per thread.
- That a live Codex thread is searchable while its turn runs (the paginated store is
  written as it goes — inferred from `thread/list` showing live threads today).
- That the cost scales as measured on real line lengths (the fake's lines are ~1.6 KB;
  longer tool_result lines only make the prefilter cheaper per byte, not slower).
- That a mirror file mid-rsync (`--inplace`, `sync.ts:9`) reads as a clean prefix — the
  reader tolerates a torn last line (JSON.parse fails → skipped), so the worst case is a
  hit missed until the next pull.
- `docs/codex-cli-contract.md` has no `thread/search` entry today (it ends at §21);
  until the planned CODEX§22 lands with the PR, the allow-list change rests on the
  probes above only.
- Remote Codex entirely (#99).

## 9. The one product question for the owner

**Where does "search every conversation" live?**

1. **(Recommended) Its own dialog, opened by Edit ▸ Search Sessions (⌥⌘F)**, built from
   the Restore dialog's parts. Cost: one more key to learn; ≈ +400 runtime lines; when
   the #6 palette is built, this dialog's list moves into it and the menu item goes —
   the search code stays.
2. **A filter row above the sidebar list** (the Files-tab pattern, `.ft-search`), rows
   without a hit hidden while you type. Cost: the live board goes blank while you
   search — waiting and approval rows included; hits for sessions not in the list need
   a second row kind in the sidebar; about the same code.
3. **Wait for #6 and ship it as the palette's first mode (⌘K).** Cost: this feature
   blocks on a decision #6 is already waiting for, and the palette's shape and key get
   decided by this feature instead of by #6.
