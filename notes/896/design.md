# #896 — Type `index.html` in the Workbench address bar to open the file in this folder

Issue #896 (a GitHub issue): "Typing a file name like index.html in the Workbench address
bar searches the web instead of opening the file in this folder".

## Today

What the user sees, in a web tab of the Workbench (the helper panel beside a session):

- The empty web tab says **"No page open yet"** and under it
  **"Press ⌘L and enter an address (http(s) / file://)"**
  (`src/renderer/src/components/WorkbenchWebGuests.tsx:170-171`).
- The address bar's grey hint text is **"Search or enter address (http(s) / file://)"**
  (`src/renderer/src/components/BrowserAddressBar.tsx:82`). At a 440 px panel the bar
  shows about 31 characters, so this line is already cut after "(http(s" (see `index.html`).
- Pressing Enter calls `submitAddress` (`src/renderer/src/components/WorkbenchPane.tsx:573-597`).
  The only path help it gives is `~/` → the Mac's home folder (line 578). Then
  `routeFor(entry, 'address')` (`src/shared/browserRoute.ts:58-63`) decides:
  - starts with `/` → `localTarget` (lines 32-36): a page (`.html/.htm`) opens as
    `file://` in the web tab; Markdown, an image or a PDF opens in a file tab (line
    581-585); **any other file does nothing at all** (`drop`; pinned by
    `test/unit/browserRoute.test.ts:188`, `/w/app.bin → drop`);
  - looks like a host (`HOST_LIKE`, line 17; `isHostPort`, lines 38-41) → `http://<entry>`;
  - anything else → a DuckDuckGo search (line 46).

So, for a session whose folder holds these files:

| typed | what happens today |
|---|---|
| `index.html` | DuckDuckGo search (`.html` is kept out of `isHostPort`, line 40; pinned by `browserRoute.test.ts:176-180`) |
| `docs/a.html` | DuckDuckGo search (`docs` is not a host) |
| `notes.md` | goes to `http://notes.md` (it matches `HOST_LIKE`; only `.html/.htm` are kept out) |
| `src/app.ts` | DuckDuckGo search (`src` has no dot, so it is not a host) |

The user has to build the whole `file:///Users/…/.claude/worktrees/<name>/index.html`
by hand (the owner's 2026-10-22 comment: one part typed wrong, file not found).

**Which folder a tab's session is in — already known.** `WorkbenchPane` gets a `treeRoot`
prop (`WorkbenchPane.tsx:125`), set in `App.tsx:1309-1313` from
`selectionRoot(tab, session.treeRoot, …)` (`src/renderer/src/sessionRows.ts:343-349`):
the session's `treeRoot`, else the tab's `cwd`. This is the same folder the Files tab
(Browse and Changes) and the Workbench shell use (`store.ts:1064-1070`).
- Claude Code moving into a worktree: the app moves `treeRoot` to the worktree folder
  (`src/main/sessionTracker.ts:986-1002`, `land` at 1216-1225).
- Codex, Muse Code, Antigravity worktree sessions: Koloft makes the worktree and starts
  the agent in it — `cwd = resource.worktreePath` (`src/main/storedSessions.ts:675-677`),
  then `treeRoot: run.cwd` (line 775).
- A remote (SSH) tab: `treeRoot` is a key like `ssh://host/path`
  (`src/shared/remoteKey.ts:8-24`, `src/main/index.ts:1269`).

**How the renderer can tell that a file exists — a check that is already there.**
`ArtifactPane.tsx:87-95` has `fileExists(p)`: it calls `window.api.preview.readText(p)`;
a missing path fails with `KOLOFT_READ_FAILED`, a folder with `KOLOFT_NOT_FILE`, and a
file that is too large or binary (`KOLOFT_TOO_LARGE`, `KOLOFT_BINARY`) still counts as
there. `readText` goes through `hosts.of(p)` (`src/main/index.ts:5573-5576`), so it works
for local and remote paths: locally one `stat`, then for a text file under 2 MB one read
(`src/main/host/localHost.ts:155-166`, `MAX_READ_BYTES`, `fileEdit.ts:12`); remotely one
ssh call. (`fs.listDir` was the first idea; it runs `git check-ignore` over the whole
folder, `fileTree.ts:26-45`, on every Enter — dropped.)

## Proposal

### Behavior (one rule)

When the user presses Enter in the address bar with a **relative path with no space** —
no `scheme:`, not starting with `/` or `~/` — Koloft first checks for that file in the
session's folder (`treeRoot`, the folder the Files tab shows; for a worktree session, the
worktree):

```
typed "index.html"
      │
      ▼
 scheme:? starts with / or ~/? has a space? ──yes──► today's routing, unchanged
      │ no
      ▼
 path = <session folder>/<typed>, minus any ?… or #… part
 path outside the session folder (../ climbing out)? ──yes──► today's routing
      │ no
      ▼
 is path a file?  (fileExists → one readText call)
      │ yes                                   │ no (missing, a folder, or no folder known)
      ▼                                       ▼
 open it (rules below)                 today's routing: host → http://, else search
```

What "open it" does — the same split as the "Open file…" picker
(`openFilePicker`, `WorkbenchPane.tsx:556-571`), calling `openHere` directly, never
`routeFor` (which would drop `.ts`, `.json` and the like):

- a web page (`.html`, `.htm`) in a **local** tab → the web tab goes to
  `file:///…/index.html`, with the typed `?…` and `#…` put back on the end
  (`index.html#intro` keeps `#intro`);
- any other file (`.md`, an image, `.pdf`, `.ts`, `Makefile`…) → `openHere({ kind: 'file',
  path })`, a file tab.

Decided here, not by the owner (mechanism):

- The file check runs **before** the host check, so `notes.md` that exists opens the file
  instead of `http://notes.md`; if it does not exist, today's `http://notes.md` stays.
- The check is "a file with that name exists", so a name with no dot (`Makefile`,
  `LICENSE`) opens too when it is there, and "koloft" searches as today unless a file of
  that name sits in the folder. No list of file kinds.
- Input with a space ("react hooks") skips the check and searches at once, so a search
  costs nothing extra. The price: a file whose name has a space (`my notes.md`) does not
  open this way.
- A folder name (`docs`) is not a file → today's routing.
- `./` and `../` are resolved with the existing `resolveOnHost` (`remoteKey.ts:42-54`),
  then fenced to the session folder the way `insideWorkspaceFence` does
  (`ArtifactPane.tsx:469-475`): a result outside it is not checked and goes to today's
  routing. On a remote tab this keeps the address bar from reading anything on the
  machine outside the session folder (`../../../etc/passwd`).
- After the check comes back, `submitAddress` reads the owner's tabs again from
  `statesRef` (line 206-208) to find the active tab, instead of using the `activeTab` it
  saw before the wait (today's lines 589-594 use the closure).
- What still waits: every space-free relative entry waits for one check before it opens
  or searches — locally one IPC call (inter-process call) with one `stat`, e.g. for
  `github.com` or `koloft`; on a remote tab one ssh round trip. `http(s)://`, `file://`,
  `localhost:5173` (it has a `scheme:`), `/…`, `~/…` and anything with a space stay
  instant, as today.

One mismatch is left on purpose: a typed **relative** `src/app.ts` that exists opens in a
file tab, but a typed **absolute** `/…/src/app.ts` still does nothing (today's `drop`).
Making `/…` and `~/…` use the same open would be about +3 lines and changes the pinned
`/w/app.bin → drop` case; it is in Out of scope below, not done here.

### Every kind of session tab

| tab | what it does |
|---|---|
| Claude Code, local | the rule above; folder = `treeRoot` (the worktree in a worktree session) |
| Codex, local | the same (`storedSessions.ts:675-677, 775`) |
| Muse Code, local | the same |
| Antigravity, local | the same |
| Claude Code, remote (SSH) | the same rule, one named difference: the file opens in a **file tab** even when it is a web page, so `index.html` shows as its source text, not drawn. The Workbench browser runs on this Mac and `routeFor` refuses `ssh://` (`browserRoute.ts:81-82`). The file tab and the Files tab's reading area are the same component, `ArtifactPane` (`WorkbenchTabHosts.tsx:85`, `FilesView.tsx:766`), and the reading area already shows a remote page as source (`test/e2e/remote-workspace.spec.ts:607`, E-RW-25). The fence above applies. |
| Codex, Muse Code, Antigravity, remote | the same as remote Claude Code |

No agent-specific code: the folder comes from `treeRoot`, which every tab kind has, and
the open goes through the existing `openHere`.

`~/` keeps meaning the Mac's home in every tab (today's line 578), remote ones included;
not changed here.

### Wording

Both lines change, in every tab (see the question below for the choice). Recommended:

- address bar placeholder: **"Search, address or file name"** (short on purpose, so it
  shows whole at 440 px)
- empty web tab, first hint: **"Press ⌘L and enter an address, or a file in this folder like index.html"**

### Files and functions that change (about +28 / −4 runtime lines)

- `src/shared/browserRoute.ts` — new pure `folderFileOf(entry, root)`: returns
  `{ path, suffix }` for a relative, space-free entry — `path` from `resolveOnHost(root +
  '/', entry)`, `suffix` the typed `?…#…` part — or `null` for a scheme, `/`, `~/`, a
  space, an empty entry, no root, or a path outside `root`. (~10 lines)
- `src/renderer/src/components/ArtifactPane.tsx:87` — export the existing `fileExists`.
  (1 line changed)
- `src/renderer/src/components/WorkbenchPane.tsx` — `submitAddress`: when `folderFileOf`
  gives a path, `await fileExists(path)`; found → local page: `file://` URL + suffix into
  the owner's active web tab (re-read from `statesRef`) or a new one; otherwise
  `openHere({ kind: 'file', path })`. Not found → today's body, unchanged. (~16 lines)
- `src/renderer/src/components/BrowserAddressBar.tsx:82` — placeholder text. (1 line)
- `src/renderer/src/components/WorkbenchWebGuests.tsx:171` — hint text. (1 line)

No new IPC, no change in `src/main`, no ADR.

## Questions for the owner

### 1. The two lines (placeholder and empty web tab)

- **A (recommended)** — placeholder "Search, address or file name"; empty tab "Press ⌘L
  and enter an address, or a file in this folder like index.html". The user learns it the
  first time they open a web tab, and the bar keeps a short hint after a page is open.
  Cost: two text lines. Leaves out: which folder "this folder" is (the Files tab shows it).
- **B** — keep both of today's lines and add one more line to the empty tab under the
  first: "Or type a file in this folder, like index.html". Cost: one new line. Leaves out:
  any hint in the bar itself once a page is open, and the old, cut-off "(http(s) /
  file://)" stays.
- **C** — A, with the folder's own name in place of "this folder" (placeholder "Search,
  address or file in issue-896"; empty tab "Press ⌘L and enter an address, or a file in
  issue-896 like index.html"; the name is the last part of `treeRoot`). Clearest in a
  worktree session, where "this folder" is not the workspace. Cost: about +4 lines (one
  prop through each of the two components); the placeholder is cut off at 440 px.

### 2. A remote (SSH) tab

- **R1 (recommended)** — the same rule; a file opens in a file tab, a web page as its
  source text. Same wording as local. Cost: every space-free relative entry on a remote
  tab — `github.com`, `koloft`, a missing file — waits one ssh round trip before it opens
  or searches (entries with a space and full URLs do not wait); about +1 line for the
  "remote → file tab" check. Leaves out: a drawn page on a remote tab.
- **R2** — a remote tab keeps today's routing for every relative entry, with no wait, and
  keeps today's two lines. Cost: about +6 lines (a "remote" prop through both components so
  their wording can differ). Leaves out: remote users get nothing from this change.

## Facts used

- Claude Code's `-w <name>` makes the worktree at `<repo>/.claude/worktrees/<name>` —
  `docs/claude-code-contract.md` §4.
- Claude Code writes `worktree-state` records into the transcript when it moves into a
  worktree, which Koloft reads to move `treeRoot` — `docs/claude-code-contract.md` §2
  (cited by `sessionTracker.ts:986`).
- A Codex, Muse Code or Antigravity worktree session runs in the worktree Koloft made,
  so its `treeRoot` is that worktree — Koloft's own code, `storedSessions.ts:675-677, 775`
  (checked by reading; not an agent CLI fact).
- `readText` reaches a remote machine through `hosts.of(p)` (`src/main/index.ts:5573-5576`);
  a remote file in `ArtifactPane` already shows as source (E-RW-25). A **file tab**
  opened from the address bar with an `ssh://` path is the same component, but that
  route itself is **inferred, not checked** (no test opens one yet).
- On macOS the check is a `stat`, and the Mac's usual disk ignores letter case, so
  `Index.html` finds `index.html` and opens it (under the typed spelling) — **inferred,
  not checked** (APFS's default; a case-sensitive disk would miss and search). A remote
  Linux machine is case-sensitive — **inferred, not checked**.
- The Workbench browser cannot draw a file that lives on the remote machine: this is the
  app's own routing (`routeFor` drops `ssh://`, `browserRoute.ts:81-82`), not an agent CLI
  fact.
- No agent CLI behavior (Claude Code, Codex, Muse Code, Antigravity) changes or is relied
  on beyond the two Claude Code facts above.

## Tests

Existing test that would change: none goes red (checked: no file under `test/` holds
"No page open yet", "Press ⌘L" or "Search or enter"; `typeInAddressBar` does not find
the bar by its placeholder). `browserRoute.test.ts:176-180` ("searches rather than
navigates for … a bare page name") stays true, because `routeFor` is not changed; the
folder check happens before it, in `submitAddress`.

New:

- `test/unit/browserRoute.test.ts` — `folderFileOf`: `index.html`, `docs/a.html`,
  `./x.md` resolve inside a local root and inside an `ssh://host/path` root;
  `index.html?x=1#a` keeps `?x=1#a` as the suffix; `../x.md` and `a/../../x` climbing out
  of the root give `null`; a scheme (`https://x`, `localhost:5173`), `/abs`, `~/x`,
  `react hooks`, an empty entry and a `null` root give `null`.
- `test/e2e/browser-routing.spec.ts`, next to the case at line 498 — "a file name typed in
  the address bar opens that file from the session's own folder": start a worktree session
  (`openWorktreeSession`), put a different `index.html` in the workspace root and in the
  worktree, type `index.html#top` → `guestByUrl('file://' + <worktree>/index.html#top)`;
  type `notes.md` (exists) → a file tab; type `missing.html` → a DuckDuckGo search (BB-M06's
  `hostResolverSwitch(['duckduckgo.com'])` pattern).
- the same case once more for a local Codex tab (`installCodex`), since the folder comes
  from the same `treeRoot` but the session kind differs.
- `test/e2e/remote-workspace.spec.ts`, next to E-RW-25 (if R1) — on a remote tab, type
  `page.html` in a new web tab's address bar → a file tab showing "on the machine" as
  source; type `../outside.html` (a file that exists one level up on the machine) → a
  search, not a file tab.

E2E flows to run for the change: `browser-routing.spec.ts` (the address bar and the new
cases) and `remote-workspace.spec.ts` (the remote case and E-RW-22/25 beside it).

## Out of scope

- Making a typed absolute `/…` or `~/…` path open any existing file in a file tab, as the
  relative path now does (about +3 lines; changes the pinned `/w/app.bin → drop` case).
- A file name with a space (`my notes.md`): skipped so searches never wait.
- The missing-`file://` error page (`ERR_UNEXPECTED`) — #928, fixed separately.
- `site/demo/browser.frames.js:1` (the site's recorded demo) still holds the old
  "Search or enter address" text; it changes the next time the demo is recorded.
