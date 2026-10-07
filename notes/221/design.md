# #221 — warn when two sessions write the same file

Issue #221 (a GitHub issue, a request for a change): when two live sessions in one
checkout have both written the same file, show a warning on both.

## What the user sees

In the sidebar, both session rows get a small amber file icon next to the title, in
the same spot the "a file was opened here" icon already uses. Hover it and the text
says who else wrote what, one line per other session:

```
Session A also wrote: agent-notes.ts, index.css
```

That is all. The icon is there while the clash holds and goes away by itself when it
stops holding: one of the two sessions ends, is closed, or types `/clear`.

Two things to know, both coming from the set of "written" files the app already
keeps (see the next section):

- **A resumed session brings its whole history.** Resume Session A, which wrote
  `index.css` last week and committed it; Session B edits `index.css` today → both
  rows show the icon, although A is not touching that file now. That is what the
  Changes view's Ownership filter already says about A, so the design keeps the two in
  step. Dropping writes older than the resume would need a new field over IPC
  (`bindMs` lives on the tracker's `Tracked`, `sessionTracker.ts:456-500`, not on
  `BackendSessionInfo`, `src/shared/types.ts:491-520`) and a second meaning of
  "written"; not in this design.
- **`/clear` must really empty the list — today it does not.** See "A small main fix".

Nothing else fires: no toast, no red dot, no Dock badge, no OS notification. A clash
is a state, not an event — the row shows it for as long as it is true. The roadmap and
`test/e2e/attention-outlets.spec.ts:38-44` already settle this: the sidebar carries no
roll-up, no toast says it, and a red dot means exactly "this session is waiting for
you".

Mockup: `index.html` next to this file — today and after, side by side, built from the
app's compiled stylesheet and the real `.ws-tab` DOM.

## What "the same file" means

Two live sessions clash on a file when both have it in their **written** set and the
file has the same key: **(machine, absolute path)**.

- machine = `info.remote?.host`, or "local" (`src/shared/types.ts:516`).
- absolute path = `files[].src` with `access === 'wrote'` (`src/shared/types.ts:352-360`,
  `:508`).

Why this key and nothing more:

- Two sessions in different worktrees never clash: each worktree is its own folder,
  so the absolute paths differ. No worktree logic is needed.
- The key is not scoped to a workspace: two workspaces pinned at one folder still
  clash, which is right.
- Claude's paths are realpath'd before they land in `files` (`canonFile`,
  `src/main/sessionTracker.ts:1707-1719`); a remote session's paths are kept as the
  machine reported them (`:1711`, ADR-0025).

**"Written" is the same set the Changes view's Ownership filter already uses**
(`writtenPaths`, `src/renderer/src/components/changesModel.ts:149-153`). Reusing that
set means the word "written" has one meaning in the app. The consequences, all read
from the code:

| Event | Claude (local and remote) | Codex (local) |
| --- | --- | --- |
| A Write / Edit / MultiEdit / NotebookEdit tool call | enters the set (`sessionTracker.ts:1567-1572`) | a `fileChange` item with `status: "completed"` enters the set (`codexObservation.ts:392-409`, CODEX§12) |
| A write through the shell (`echo >`, `sed -i`, `tee`) | never enters the set — it only bumps `liveWrites` (`sessionTracker.ts:1559-1561`) | never enters the set (#104, CODEX§12: it arrives as `{type: "unknown"}`) |
| More than 300 files touched | the list is capped at 300, writes kept first (`touchedFiles.ts:11, :42-49`); a write past the cap is invisible | same cap |
| `/clear` | the tab binds to a new session id (CC ledger; `sessionTracker.ts:1083-1090`); the parse state is emptied — but today the **published** list is not, see "A small main fix" | `/clear` sends `thread/start` with a new id (CODEX§21, `codex-cli-contract.md:779-780`); `touched.clear()` runs (`codexObservation.ts:258`) — but today the **published** list is not re-sent, same fix |
| Resume | the whole transcript is read again from offset 0, so every file the session ever wrote counts (`sessionTracker.ts:1083-1103`) | the file list is seeded from the `thread/resume` reply's turns (`codexObservation.ts:271, 381-389`; CODEX§12, measured 2026-09-29) |
| Session ends or its tab closes | `alive` goes false (`sessionTracker.ts:622-626`); it drops out of the check | the run is deleted (`codexSessions.ts:986`), so the session leaves the list altogether; same effect |

Live sessions only: `alive === true`. A cold row (ended session) has no tab, cannot
write, and so never clashes; its old writes stop counting the moment it ends.

### A small main fix: `/clear` leaves the old list on screen today

On both backends the in-memory set is emptied at the new bind, but the list the
renderer holds is only replaced when something new is published:

- Claude: `resetParseState` empties `t.candidates` (`sessionTracker.ts:1023-1054`) but
  never `t.info.files`; the only write to `t.info.files` is `recompute`
  (`:1695`), which `parseOnce` runs only when the transcript grew (`:1236, :1242`).
  After `/clear` the new transcript is empty, so the old list stays until the new
  session's first tool call.
- Codex: `publishFiles` runs on bind only when the seed found something
  (`codexObservation.ts:388`); a fresh `thread/start` has no turns, so
  `info.files` in `codexSessions.ts:808` keeps the old list.

So without a fix, two sessions that both `/clear` would keep showing the icon. The
fix is two lines of main code:

- `sessionTracker.ts` `bind()` (`:1083`): after `resetParseState`, set `t.info.files = []`
  and `emitUpdate()`.
- `codexObservation.ts` (`:271`): publish the file list on every bind, empty or not
  (`seedFilesFromHistory` always calls `publishFiles`).

This also fixes the same staleness in the Changes view's Ownership filter after a
`/clear`, which nobody had noticed because the list is right again after one write.

## Where it lives in the UI

One new mark in the session row, built exactly like `UnseenFileMark`
(`src/renderer/src/components/WorkspaceSidebar.tsx:149-160`):

```
<span className="ws-tab-clash" title={lines.join('\n')}>
  <LuFileWarning size={12} />
</span>
```

It renders right after `<UnseenFileMark>` and before the red dot
(`WorkspaceSidebar.tsx:1023-1029`), so the row's order is: title · opened-file icon ·
clash icon · red dot · parked badge. `LuFileWarning` is in the installed
`react-icons/lu` (checked: `grep` on `node_modules/react-icons/lu/index.d.ts`).

The tooltip names the other session the way its own row is titled: the component
resolves titles with the same expression the row uses (`WorkspaceSidebar.tsx:1018-1020`:
`sess.title` unless it is the Claude placeholder, else `row.title`). That line checks
only `PLACEHOLDER_SESSION_TITLE`, not `CODEX_PLACEHOLDER_TITLE`; a Codex row with no
preview yet shows "Codex session", and the tooltip would say the same, so the two agree
either way.

CSS: one rule next to `.ws-tab-opened` (`src/renderer/src/styles.css:5186-5192`):

```
.ws-tab-clash {
  flex: 0 0 auto;
  display: flex;
  color: var(--amber);
}
```

`--amber` is the existing warning token (approval bar, behind badge). No new hex
literal, so `styleVars.test.ts` T-SPEC-02 stays green.

The sidebar hidden → the mark is not visible. That is the same gap the red dot has,
and the jump shortcut answers it the same way. Not fixed here.

## How each of the four tab kinds behaves

| Tab kind | What it does |
| --- | --- |
| Local Claude Code | Full. Writes come from the transcript's tool calls; paths realpath'd. Shell writes are blind (named gap, same as the Ownership filter). |
| Local Codex | Same mark, same rule. Writes come from `fileChange` items only; shell writes are blind (#104). After a resume the list is seeded from the thread's old turns (CODEX§12). A Codex and a Claude session in one folder clash with each other — both put absolute paths in `files`. |
| Remote (ssh) Claude Code | Same mark, same rule. Writes come from the mirrored transcript, so the mark lands one mirror pull late — like the row's state. Key uses `remote.host`, so a path on machine A never clashes with the same path on machine B; two sessions on one machine do. |
| Remote (ssh) Codex | Left out: it does not run (#99, `SUPPORTED_PAIRS` in `src/shared/sessionBackend.ts`). Lights up by itself when #99 lands, since the check keys off `SessionInfo` only. |

## Code it touches (today's tree)

| File | Change | Size |
| --- | --- | --- |
| `src/renderer/src/sessionRows.ts` | new pure function `writeClashes(sessions): Map<tabId, { tabId: string; files: string[] }[]>` — walks live sessions' written files, keys by (host, path), pairs every tab that shares a key, files as basenames; no titles in here, the component resolves them | +22 |
| `src/renderer/src/components/WorkspaceSidebar.tsx:178` | `const clashes = useMemo(() => writeClashes(sessions), [sessions])` | +1 |
| `WorkspaceSidebar.tsx:1023` | render the `ws-tab-clash` span when `clashes.get(tabId)` is non-empty; its `title` maps each other tab to the title its row shows | +12 |
| `src/renderer/src/styles.css:5192` | the `.ws-tab-clash` rule | +5 |
| `src/main/sessionTracker.ts:1090` | `t.info.files = []` + `emitUpdate()` after `resetParseState` in `bind()` | +2 |
| `src/main/codexObservation.ts:388` | publish on every bind, empty list included | +1 / −1 |

Runtime: about +43 / −1 under `src/`. No IPC change, no new type: everything the
check needs is already in `SessionInfo` (`files`, `alive`, `remote`, `title`, `tabId`)
and already in the renderer store (`useStore((s) => s.sessions)`,
`WorkspaceSidebar.tsx:178`).

## Tests

Which existing test goes red if this breaks? None — it is new behavior. So:

**Unit**

- `test/unit/sessionRows.test.ts` (exists), one `describe('writeClashes')`:
  two live sessions that wrote one path → each lists the other's tab and the basename;
  same path on two machines (`remote.host` differs) → nothing; one not alive →
  nothing; one read, one wrote → nothing; three files, two other sessions → grouped
  per other tab.
- `test/unit/sessionTracker.test.ts` (exists): "after a `/clear` the published file
  list is empty until the new session writes".
- `test/unit/codexObservation.test.ts` (exists): "a `thread/start` after writes
  publishes an empty file list".

**E2E** — a new flow, `test/e2e/same-file-warning.spec.ts`:

1. Local Claude: Session A `/write src/x.ts`, Session B `/write src/x.ts` (same
   workspace, same path) → both rows show `.ws-tab-clash`, each title names the other
   session. The mark adds no attention: the rows with `.ws-tab-unread` still equal
   `pendingAttention(page)` exactly (the pattern of `attention-outlets.spec.ts:29-36`;
   each `/write` ends in a Stop, so the pending list itself grows — that is normal),
   and no toast at any moment of a window. That check is
   `expectNoToastAtAnyMomentOfAWindow`, today file-local in `cron-edge.spec.ts:182`:
   move it to `test/e2e/helpers` first, and point cron-edge at the helper. Then B
   types `/clear` → the mark leaves both rows. Barrier: B's row carries its new
   session id (`fake-claude.js:611-624` prints `cleared -> session <id>`, and the row's
   `data-tab-id` stays while the session row id changes), then `.ws-tab-clash` has
   count 0 — this is the step that proves the main fix.
2. Local Codex beside Claude: Claude writes `src/x.ts`, Codex writes the same path →
   both rows marked. This needs `test/e2e/fixtures/fake-codex.js` to grow a typed line
   `write <path>` that emits one `item/completed` `fileChange` item in the shape CODEX§12
   records (absolute `path`, `kind: {type: "update", move_path: null}`, a one-hunk
   `diff`, `status: "completed"`). Today the fixture emits only `commandExecution`
   items (`fake-codex.js:159-175`). About 15 fixture lines.
3. Remote Claude: in `test/e2e/remote-workspace.spec.ts`, one case with two sessions in
   `proj` that both `/write` the same relative path; both rows marked within that
   spec's 90 s mirror-pull budget. Two sessions in `proj` is already how E-RW-01 ends
   (`remote-workspace.spec.ts:141-144`).

Untouched: `attention-outlets.spec.ts` stays as it is and stays green — the new mark is
not `.ws-tab-unread`, adds nothing to the pending list, and is per row, not a strip.
`workbench-changes.spec.ts` WB-C15 (two sessions on one worktree) is unchanged.

## Inferred, not checked

1. **A Claude + Codex clash in a workspace reached through a symlink may be missed.**
   Claude paths are realpath'd (`sessionTracker.ts:1713-1716`); Codex paths are taken
   as Codex sends them, after an `isAbsolute` check only (`codexObservation.ts:399`).
   On the Codex side only the trust-table header is realpath'd (`codexTrust.ts:10`);
   the launch cwd (`codexSessions.ts:645-668`) is not. On macOS `/tmp` is really
   `/private/tmp`, so the two keys could differ for one file. The e2e suite cannot
   catch this: its home is realpath'd up front (`helpers/env.ts:49`). Probe: a
   workspace pinned through a symlink, one Claude and one Codex session, both write one
   file, compare `files[].src` in the two `SessionInfo`s. If they differ, the fix
   belongs with #104 (canon the Codex path the same way), not here.
2. **Two remote Claude sessions on one machine report one file by the same path
   string.** Both come from the same `claude` on the same machine, so this is likely,
   but it was not probed. Probe: the remote e2e case above.
3. **Real `/clear` in Claude Code binds the tab to a new session id** — read from the
   tracker's code and from fake-claude's `/clear`, which the suite drives; the real
   tool's behavior is in the Claude Code ledger, not re-probed here. (Codex's is
   measured: CODEX§21.)
4. **#104 point 1 ("empty after a resume") looks already fixed on today's tree**
   (`seedFilesFromHistory`, and CODEX§12 says Koloft seeds on every bind, measured
   2026-09-29). The issue is still open; not re-run against a real `codex` for this
   design.

## The one product question for the owner

**Where does the warning show?** (A toast is not on the table: the roadmap and
`attention-outlets.spec.ts:43-44` already say no toast from the sidebar.)

- **A — the sidebar row only (recommended).** Both rows get the amber file icon;
  hover names the other session and the files. Cost: it is only in the sidebar — with
  the sidebar hidden nothing shows, and the user hovers to learn which file. About
  +43 lines, one new e2e spec plus one remote case.
- **B — A plus a mark on the file's own row in the Changes list** (Workbench ▸ Files ▸
  Changes), saying "also written by Session A". Cost: about +20 more lines —
  `ChangesView` today knows only its own session (`ChangesView.tsx:130`), so it would
  start reading every session from the store, `ChangeEntry` gains a `clash` field
  (`changesModel.ts:6-15`, `:163-190`), and `workbench-changes.spec.ts` gains an
  assertion. The owner sees the file without hovering, in the place where files are
  read.
