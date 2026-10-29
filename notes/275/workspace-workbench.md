# #275 — a Workbench for the workspace row

Issue #275 (GitHub issue number 275) asks that the "12 open issues" and "3 open pull
requests" counts open their lists. The owner's direction (2026-10-28): a workspace row has
a Workbench of its own, and those counts always open in **that workspace's** Workbench.
This note designs that Workbench. The old options A/B/C (`design.md`) are dropped.

Mockup: `mockups/275/workspace-workbench.html` (four screens).

## Today

### What the screen shows when a workspace row is selected

A click on a workspace row runs `selectWorkspace(path)`, which sets `selectedWs` and
`lastWsPath` and clears `activeTabId` (`src/renderer/src/store.ts:1079-1080`). With no
active tab, the center shows the workspace's **welcome page** (`App.tsx:1739-1782`, the
`.w-empty` block): the folder name, "No running session" or "N running", "＋ New session",
"New worktree session…", and a "Recent" list. The workspace is picked by
`welcomeTarget(rows, lastWsPath)` (`sessionRows.ts:311-317`), so the same page shows after
the last session tab closes, not only after a row click.

The right side is empty. The Workbench belongs to the selected tab:
`panelTab = hasWorkbench(landedTab) ? landedTab.id : undefined` (`App.tsx:1278`), and
`hasWorkbench` is true only for a session tab (`agentUi.ts:28-34`). With no tab, the
Workbench button on the right edge still shows but greyed out (`aria-disabled={!panelReady}`,
`App.tsx:1875-1885`, where `panelReady` needs a bound session, `:1289-1290`; the site's recorded frame of this page shows the same).

### What a session's Workbench is made of

| Part | What it is | Where |
|---|---|---|
| Files (always first, cannot close) | the folder tree, with its changed-files view and the "+N −M" totals; rooted at the session's own folder (its worktree for a worktree session) | `workbenchTabs.ts:13`, `:54-58`; root from `selectionRoot` (`sessionRows.ts:356-363`) |
| File tabs | a file opened from Files or by the agent | `workbenchTabs.ts:82-88` |
| Web tabs | pages, with address bar, back/forward, downloads | `BrowserAddressBar`, `WorkbenchWebGuests.tsx` |
| Terminal (shell) tabs | a shell in the session's folder, tagged with `ownerTabId` | `store.ts:1088-1106` |
| GitHub button in the tab strip | opens the repo or the branch's PR; right-click menu | `workbenchGithub.tsx`, `WorkbenchPane.tsx:1250-1266` |

At most 8 tabs of each kind (`PERSISTED_TAB_CAP`, `workbenchState.ts:3`).

**Where it is kept.** In memory, by the session tab's id: `workbench[tabId]`,
`workbenchOpen[tabId]` (`store.ts:123`, `:353-358` moves the keys when the tab id
changes). On disk, by the **session id** bound to the tab: `writeWorkbench` sends
`{ open, tabs }` for `boundSessionId(s, tabId)` (`store.ts:510-516`) to main, which stores
it in `layout.json` under `panels[sessionId]` (`workspaces.ts:523-535`, `layout.ts:11`) —
only for a session Koloft owns (`isMember`, `workspaces.ts:532`). Web and file tabs are
saved; terminal tabs are not (`sanitizeTab`, `workbenchState.ts:17-31`).

**Who can put a page there.** The user (+ menu, address bar, a link in the terminal or a
file preview via `openWebPage`, `store.ts:1320-1327`), and the session's agent
(`koloft open`, the agent's browser over CDP — `openCdpTab`, `tabForSession`,
`followsAgentBrowser`, `store.ts:1055-1077`).

### The note

The workspace's note is the "Notes · <folder>" island in the sidebar, one file per
workspace under the app's data folder (`NotesIsland.tsx`). It is not in the Workbench and
does not change here.

## Proposal

### In one picture

```
 sidebar                 center                         right
 ┌────────────────┐      ┌───────────────────────┐      ┌──────────────────────────────┐
 │ ▸ repo  ⑂ !12 ⇄3│ ──► │ repo                   │      │ Files │ Issues · acme/repo ✕ │
 │   session A    │      │ 1 running              │      │ github.com/acme/repo/issues  │
 │   session B    │      │ [＋ New session]       │      │                              │
 └────────────────┘      │ New worktree session…  │      │   (the GitHub issues page)   │
   row selected          │ Recent …               │      │                              │
                         └───────────────────────┘      └──────────────────────────────┘
                          unchanged welcome page          the WORKSPACE's Workbench
```

- When the center shows a workspace's welcome page, the Workbench button is live and
  opens **that workspace's Workbench**. It belongs to the workspace row, not to any session.
- When a session tab is selected, the right side is that session's Workbench, exactly as
  today. Session Workbenches do not change.

### What the workspace Workbench holds

| Tab | In it? | Why |
|---|---|---|
| Files (with its changed-files view) | **yes**, rooted at the workspace folder (the main checkout) | It is the always-there first tab of every Workbench (`emptyTabSet`, `workbenchTabs.ts:57-58`), and `fileTreeRoot` already falls back to the welcome workspace's folder today (`App.tsx:1318-1322`). No new code to have it. Named difference: a worktree session's Files shows its worktree; this one shows the main folder. |
| File tabs | **yes** | A file clicked in Files opens as a file tab; same code. |
| Web tabs | **yes** | The issue and PR lists, and any page the user opens with "+" or the address bar. The GitHub button in the tab strip works too: it needs only the folder (`useWorkbenchGithub(visible, treeRoot, session, …)`, `workbenchGithub.tsx:110-118`); with no session, its "send failing checks to the session" item has no session to paste into (`pasteTab = session?.tabId ?? null`, `:133`) and is left off. |
| Terminal (shell) | **no** (recommended; see Question 1) | A Workbench shell is tied to a session tab: its folder is read from that tab (`store.ts:1095-1099`), it is tagged `ownerTabId`, it keeps that tab from closing on its own (`heldTabs`, `src/main/index.ts:686-692`), and it ends with that tab. A workspace row never closes, so a shell there would need a new rule for when it ends. The "+" menu shows "Terminal" greyed out, the way it does for a stopped session (`canTerminal={!sessionCold}`, `WorkbenchPane.tsx:1296`; the workspace key counts as live, so this needs its own check). |

**No agent drives it.** `koloft open`, a link clicked in a session's terminal, and an
agent's browser keep going to that **session's** Workbench, never to the workspace's: the
workspace Workbench has no session (`tabForSession` never returns it). A link clicked while
the welcome page is up still goes to the page overlay, as today (`openWebPage`,
`store.ts:1320-1327`) — see Out of scope.

### Clicking "12 open issues"

The counts are in the git panel, the card that shows when the mouse rests on the
workspace's git mark (`FreshnessPopover.tsx:525-541`). The plain line
`12 open issues   3 open pull requests` becomes two action rows in the panel's own
`.tbu-act` style (the same as "Fetch now" above them), with the sidebar's two icons.

```
click "12 open issues" in the panel of workspace W
   │
   ├─ panel closes at once
   ├─ the main view moves to W's welcome page (selectWorkspace(W));
   │  whatever session was on screen keeps running — the page says "1 running"
   ├─ W's Workbench opens
   └─ a web tab shows https://github.com/<owner>/<repo>/issues
      (an open tab with that page is reused, not doubled)
```

This is the owner's "always in that workspace's Workbench": it leaves the session view
even when the user was in a session of W. That is the one change a user meets that is not
"just a new panel", so it is in the "What a user sees" table below.

- The URL comes from main, `window.api.github.target(W, 'issues' | 'pulls')`, so a private
  repo goes through `github.com/login?return_to=…` when Koloft's browser is not signed in
  (`src/main/github.ts:275-290`, `docs/platform-contract.md` §32). `'issues'` is a new
  `GithubTarget` (`src/shared/types.ts`) and must be added to the IPC whitelist in
  `src/main/index.ts`. A `null` answer opens nothing, as the Workbench GitHub button does.
- A remote workspace whose machine is offline: the two rows are greyed out, like Pull and
  Fetch (`offline`, `FreshnessPopover.tsx:449`, `:493`, `:513`), because `target()` may have
  to read the remote's `git config` over the dead link when its 5-minute cache is out.
- A count of 0 still shows its row (the list has closed items too).

### What a user sees change

| Case | Today | After |
|---|---|---|
| Select a workspace row | welcome page; Workbench button grey | welcome page (same); Workbench button live; ⇧⌘B opens the workspace's Workbench |
| Open the workspace Workbench the first time | — | Files tab of the workspace folder; no other tabs |
| Click "12 open issues" / "3 open pull requests" in the git panel | plain text, nothing happens | the view moves to that workspace's welcome page, its Workbench opens on the list |
| …while a session of that workspace was on screen | — | the session keeps running in its tab; the user clicks its row to go back; the list stays in the workspace Workbench |
| Restart Koloft | — | the workspace Workbench's web and file tabs, and open/closed, come back (pages reload when shown) |
| Select a session tab | its own Workbench | same, unchanged |
| Remove a workspace from the sidebar | — | its workspace Workbench is forgotten with it |

### Where the tabs are kept

- **In memory**: the same `workbench` / `workbenchOpen` maps, under a key that cannot clash
  with a tab id: `ws:` + the workspace path. `liveTabs` must count that key as live, or its
  web tabs never mount (`sessionCold`, `WorkbenchPane.tsx:214`; a page loads only for a live
  owner, `applyLiveIn`, `:288-290`).
- **On disk**: a new optional field in `layout.json`,
  `workspacePanels: Record<workspacePath, { open, tabs }>`, same shape and same sanitizer
  (`sanitizeSessionWorkbench`) as `panels`, so the same 8-per-kind cap. No version bump:
  `migrateLayout` for version 6 already carries an optional field the same way (`resident`,
  `layoutMigrate.ts:186-197`), and it must read the new one there too or it is dropped on
  load. The entry goes when the workspace is removed (`unpin`, `workspaces.ts:670`).
- **After quitting the app**: the tabs are still there (as a session's are). Terminal tabs
  never are.
- **Downgrade** (inferred, not checked): an older Koloft drops the unknown field on its
  first save (`migrateLayout` copies only known fields, `layoutMigrate.ts:186-197`), so the
  workspace's saved tabs are lost; nothing else is.

### Each kind of session tab

The workspace Workbench belongs to no session, so which agent runs in the workspace's
sessions changes nothing. Every session's own Workbench is unchanged for all eight kinds.

| Session kind | Local workspace | Remote (SSH) workspace |
|---|---|---|
| Claude Code | its session Workbench unchanged; the workspace Workbench is the same for every agent | same as local; see the remote notes below |
| Codex | same | same |
| Muse Code | same | same |
| Antigravity | same | same |

Remote workspace notes:
- **Files** lists the remote folder over SSH: the file calls pick the host from the path
  (`hosts.of(p).listDir(p)`, `src/main/index.ts:6038-6040`), with no session needed.
  Offline, Files shows its usual "folder missing / cannot read" state.
- **Web tabs** are github.com pages: they load on the Mac, in Koloft's own browser, never
  on the remote machine. They keep working while the machine is offline.
- The panel of a remote workspace has only its GitHub part (no Pull or Fetch, T-GH-06,
  `test/e2e/workspace-github-counts.spec.ts`); the two new rows sit there.

### The "Workbench is the session's" rule

`CLAUDE.md` says: "the Workbench is the session's, the note is the workspace's". After
this change it would read:

> Each session tab has its Workbench, keyed by the tab; each workspace row has one too —
> Files of the workspace folder and web pages, no shell, and no agent drives it. The note
> stays the workspace's, in the sidebar.

### Old users after upgrading

- The welcome page looks the same. The Workbench button next to it turns from grey to live.
- The workspace Workbench starts **closed** with only Files
  (`layout.workbench.defaultOpen`, `DEFAULT_PANEL_OPEN = false`, `workbenchState.ts:5`).
- No tab moves out of any session's Workbench; `panels` is not touched.
- The first click on a count opens the workspace Workbench and its list.

### Code (inferred, not checked: about +130 / −15 lines under `src/`)

| File | Change |
|---|---|
| `src/shared/types.ts` | `GithubTarget` gains `'issues'`; `LayoutV6` gains `workspacePanels?` |
| `src/main/github.ts` | `target()` builds `/issues` beside `/pulls` |
| `src/main/layoutMigrate.ts` | read `workspacePanels` for version 6 |
| `src/main/workspaces.ts` | `workspaceWorkbenchState(path)`, `setWorkspaceWorkbenchState(path, state)` (pinned paths only); drop it in `unpin` |
| `src/main/index.ts` + `src/preload/index.ts` + `ipcChannels.ts` | two IPC calls for the above; `'issues'` in the `target` whitelist |
| `src/renderer/src/store.ts` | a workspace key `ws:<path>`: `workbenchAllowed`, `ensureWorkbench`, `writeWorkbench` read and write it through the new calls instead of `boundSessionId`; `openWorkspaceList(path, what)` = select workspace, open its Workbench, `openWorkbenchTarget` the URL |
| `src/renderer/src/App.tsx` | `panelTab` falls back to the workspace key when no tab is shown and the welcome page is up; `liveTabs` includes it; `panelReady` is true for it (today it needs a bound session, `:1289-1290`), so the Workbench button and ⇧⌘B work |
| `src/renderer/src/components/WorkbenchPane.tsx` | "Terminal" greyed for the workspace key |
| `src/renderer/src/components/FreshnessPopover.tsx` | the counts line becomes two `.tbu-act` rows; click → close panel → `openWorkspaceList` |

## Facts used

- Nothing here states what any agent CLI does; the per-kind table rests only on Koloft's
  code (`hasWorkbench`, `agentUi.ts:28-34`; `sessionBackend.ts` gives `workbench: true` to
  all eight kinds).
- Private repo 404 for a signed-out browser and the `login?return_to=` fix:
  `docs/platform-contract.md` §32.
- `https://github.com/<owner>/<repo>/issues` is GitHub's issues list (checked with `curl`
  for `design.md`, HTTP 200).
- Inferred, not checked: the code size above.
- Inferred, not checked: an older Koloft drops `workspacePanels` (read from
  `migrateLayout`, not run).

## Tests (when built)

- Unit, `test/unit/workbenchStore.test.ts`: with no active tab and a welcome workspace,
  the workspace key gets a Workbench; `openWorkspaceList` selects the workspace, opens its
  Workbench, and a second call reuses the tab; a session tab's Workbench is untouched.
- Unit, `test/unit/github.test.ts`: `'issues'` → `https://github.com/acme/widgets/issues`.
- Unit, layout migration: `workspacePanels` survives a load/save; `unpin` drops it.
- E2E, `test/e2e/workspace-github-counts.spec.ts`: T-GH-01 reads the two rows instead of
  `.fx-counts`; T-GH-06 (remote) allows only the two list rows; a new case selects a
  **Codex** session in the workspace, clicks "12 open issues", and checks the welcome page
  is shown, the Codex tab still runs, and the workspace Workbench has a web tab on
  `…/acme/repo/issues`; restart keeps that tab.
- E2E flows to run: `workspace-github-counts`, `github-button`, `workbench-tabs`,
  `workbench-layout`, `browser-overlay`, `git-freshness`, `remote-git-accounts` (Docker lab).

## Out of scope

- A link clicked while the welcome page is up (e.g. in the note's preview) keeps going to
  the page overlay; sending it to the workspace Workbench is a separate choice.
- A shell in the workspace Workbench (Question 1, option B).
- Whether the sidebar row's own numbers are clickable (Question 2).
- A list of issues drawn by Koloft itself (the New Worktree Session dialog already lists
  open items for starting a session from an issue).
