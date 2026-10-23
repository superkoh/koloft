# #275 — Workspace panel: link the GitHub issue and PR counts to their lists

Issue #275 (a GitHub issue, number 275). "The panel" below is the git panel: the small
card that shows when the mouse rests on a workspace's git mark in the sidebar.

## Today

The counts still exist, in two places.

1. **On the sidebar row.** After the git mark, a workspace on GitHub shows its open issue
   and open pull request counts as small numbers with an icon
   (`src/renderer/src/components/WorkspaceSidebar.tsx:533-548`, the `.ws-gh` spans). They
   are plain text; a click on the row selects the workspace (`:483-486`). Resting the mouse
   on the git mark opens the panel (`:516-521`, `1009-1029`).
2. **In the panel.** Under the branch part, a `GITHUB · owner/repo` head and one line
   `12 open issues   3 open pull requests`
   (`src/renderer/src/components/FreshnessPopover.tsx:522-541`; the words come from
   `openIssuesLabel` / `openPullsLabel`, `src/renderer/src/freshnessView.ts:24-30`).
   This line is plain text: nothing happens on a click.

Where the numbers come from: every minute main asks GitHub through `gh api graphql` for each
pinned workspace (`src/main/githubCounts.ts:31-51`, `src/main/index.ts:3182-3186`,
`src/main/github.ts:238-250`). Only a github.com remote gets counts
(`src/shared/githubUrl.ts:6-9`).

**Remote (SSH) workspaces show the counts too.** The remote host has its own
`GithubLookup` that reads the remote's `git config` over SSH (`src/main/host/sshHost.ts:611-617`),
and `gh` runs on that machine when a Koloft git account is picked for it, else on the Mac
(`src/main/index.ts:4723-4728`, `src/main/gitAccountService.ts:589-594`). The panel of a
remote workspace has only the GitHub part, no Pull or Fetch — pinned by T-GH-06
(`test/e2e/workspace-github-counts.spec.ts:209-231`).

**How Koloft opens GitHub pages today.**

| Who | What it does | Where |
|---|---|---|
| Workbench GitHub button (and its right-click "Open repository", "Open pull requests") | asks main for the URL (`window.api.github.target`), opens it as a web tab in **that session's own Workbench**, reusing the tab if the same page is open; a `null` URL does nothing | `WorkbenchPane.tsx:1176-1187`, `workbenchGithub.tsx:234-255` |
| Any link clicked in a terminal or a file preview (`openWebPage`) | the **selected** session tab's Workbench if it has one; else the **page overlay** — an in-app browser layer over the whole window, with Back, ↗ "Open in system browser" and Close | `store.ts:1287-1298`, `BrowserOverlay.tsx:71-84` |
| Settings ▸ About "Open releases page" | the page overlay | BB-10, `test/e2e/browser-overlay.spec.ts:115` |
| This very panel's "Open SSH keys page" | the **system browser** (`window.api.browser.openExternal` → `shell.openExternal`) | `FreshnessPopover.tsx:225`, `src/main/osOpen.ts:22-24` |

`target()` turns the URL into `github.com/login?return_to=…` when Koloft's own browser is
not signed in to GitHub (`src/main/github.ts:288-289`, sign-in read from Koloft's cookie jar at
`src/main/index.ts:4733-4745`), because a private repo answers 404 to a signed-out browser
(`docs/platform-contract.md` §32). The Workbench tabs and the overlay share that one sign-in
(both use `BROWSER_PARTITION`, `BrowserGuest.tsx:151`); the system browser has its own.

## Proposal

### What the user sees

In the panel's GitHub part, the plain counts line becomes two action rows, in the same
`.tbu-act` style as "Fetch now" right above them, with the same icons the sidebar row uses:

```
 GITHUB · ACME/REPO          as alice          GITHUB · ACME/REPO          as alice
 12 open issues   3 open pull requests    →    [!]  12 open issues
                                                [⇄]  3 open pull requests
                                                (account notes, if any, stay below)
```

- The words stay exactly what they are today ("12 open issues", "3 open pull requests");
  each row gets a tooltip, "Open the issues list" / "Open the pull requests list".
- A count of 0 still shows its row (the list still has closed items).
- Notes about the git account (`gitNotes`, e.g. "alice needs to sign in again…") stay in a
  `.tbu-row` under the two rows, then the account block as today.
- **The panel closes at the click**, before the URL comes back, like "Add account…" does
  (`FreshnessPopover.tsx:76-79`); the page shows a moment later.
- If the URL comes back `null` (the repo can no longer be read), nothing opens — the same as
  the Workbench GitHub button (`WorkbenchPane.tsx:1179-1180`).
- Remote workspace with the machine offline (`offline`, `FreshnessPopover.tsx:449`): the two
  rows are greyed out with `disabled={offline}`, like Pull and Fetch (`:493`, `:513`). The
  numbers shown were counted before the link dropped, and once the 5-minute repo cache runs
  out `target()` has to read the remote's `git config` over the dead link
  (`github.ts:257-265`), so the click would wait for an SSH timeout. (Option C below never
  touches the machine and would not need this.)
- The sidebar row numbers stay plain text in the recommended plan — part of the question.

### Where the page opens (recommended option A — see the question)

```
click "12 open issues" in the panel of workspace W   (panel closes)
        │
        ├─ the selected tab is a session tab of W ──► web tab in its Workbench
        │                                             (opens the panel if shut; reuses an
        │                                              open tab with the same page)
        └─ anything else (a session of another      ──► the page overlay
           workspace, no session, Welcome screen)        (↗ there hands it to the system browser)
```

A session running in a worktree of W counts as a session of W: the workspace's rows are
built from its worktree folders too (`src/main/workspaces.ts:744-745`), and
`workspaceOfTab` looks a tab up in those rows (`sessionRows.ts:306-322`).

### Each kind of session tab

The panel belongs to the workspace, not to a tab, and never asks which agent runs; the only
thing that depends on the tab is "does the selected tab have a Workbench", and
`hasWorkbench` (`src/renderer/src/agentUi.ts:23-29`) is true for every agent on both hosts
(`src/shared/sessionBackend.ts:146-187`: `workbench: true` in all eight rows).

| Tab kind | Local workspace | Remote (SSH) workspace |
|---|---|---|
| Claude Code | same | same, plus the offline rule above; the page is a github.com page, so it opens on the Mac, never on the remote machine |
| Codex | same | same, plus the offline rule |
| Muse Code | same | same, plus the offline rule |
| Antigravity | same | same, plus the offline rule |

With the change to `target()` below, a click in a remote workspace makes **no** SSH call while
the repo is in the 5-minute cache: list pages need only the repo, not the branch.

### Code for option A (about +38 / −9 lines under `src/`)

| File | Change | ≈ lines |
|---|---|---|
| `src/shared/types.ts:867` | `GithubTarget` gains `'issues'` | +1/−1 |
| `src/main/github.ts:275-290` | at the top of `target()`: for `'repo'`, `'pulls'` and `'issues'` take the repo from `repoFor(root)` (cached, fixture-aware, `:318-322`) and build `repoUrlOf(repo)` (+ `/pulls` or `/issues`) without calling `info()`, so no `git rev-parse` runs for a list page; the sign-in redirect stays | +5/−2 |
| `src/main/index.ts:5663` | the IPC whitelist accepts `'issues'` (easy to miss) | +1/−1 |
| `src/renderer/src/store.ts` | `openWorkspacePage(wsPath, url)` beside `openWebPage`: selected tab has a Workbench **and** `workspaceOfTab(...) === wsPath` → `openWorkbenchTarget(tab, { url, source: 'user' })`; else `landOverlay(url, 'now')` | +10 |
| `src/renderer/src/components/FreshnessPopover.tsx:528-532` | the `.fx-counts` line becomes two `.tbu-act` buttons (icons `IconIssue`, `IconPullRequest`, `disabled={offline}`); click → `onClose()` → `window.api.github.target(wsPath, what)` → `openWorkspacePage` when not `null` | +21/−5 |

The `/issues` URL is written inline as `` `${repoUrl}/issues` `` inside `target()` (no new
helper: `target()` only has the repo URL string, and `pullsUrlOf` already exists for
`/pulls`). The shortcut in `target()` also makes the Workbench button's "Open repository" and
"Open pull requests" skip their `rev-parse`; their unit test (`test/unit/github.test.ts:256-262`)
keeps checking the URLs.

Rejected for options A and B: building the URL in the renderer from `github.repo` and opening
it in Koloft's browser. It skips the sign-in redirect, so a private repo would show GitHub's
404 page in Koloft's browser when not signed in (`docs/platform-contract.md` §32), unlike the
Workbench button. (For option C the renderer URL is right: the system browser does not use
Koloft's cookie jar.)

Rejected as an option: switching the user to a session of W and opening the page there. A
hover card would then move the whole main view away from the session the user was in, and
it needs a "which session" rule when W has several.

## Question for the owner

**1. Where should "12 open issues" / "3 open pull requests" open?**

- **A. (Recommended) The selected session's Workbench when that session is in this
  workspace; otherwise the page overlay.** Someone working in workspace W gets the list next
  to the session, the same as the Workbench GitHub button. Anyone else gets the in-app
  overlay that the Settings ▸ About releases link already uses, with ↗ to move it to the
  system browser, and keeps Koloft's GitHub sign-in. Never switches tabs. About +38/−9 lines.
- **B. The issue's own idea: the Workbench of a session in this workspace; the system
  browser when there is none.** Same as A when the selected session is in W. When it is not
  (another workspace's session is selected, or W has no open session), the page goes to the
  system browser, with the plain URL (the sign-in redirect only knows Koloft's own cookie
  jar). Opening it in a W session that is not on screen is left out: the page would land in
  a Workbench the user cannot see. About +42/−9 lines (A plus a system-browser branch). The
  user leaves Koloft in every case A would show the overlay.
- **C. Always the system browser.** Build `https://github.com/${github.repo}/issues` (or
  `/pulls`) in the panel (`github.repo` is at `FreshnessPopover.tsx:525`) and call
  `window.api.browser.openExternal`, exactly like "Open SSH keys page" (`:225`). No new
  `target`, no IPC, no `types.ts`/`index.ts`/`store.ts` change, no offline rule; about
  +18/−5 lines, all in `FreshnessPopover.tsx`. The user always leaves Koloft, and Koloft's
  GitHub sign-in is not used (the user's own browser is usually signed in already).
  It also stays clear of open Workbench-browser problems that touch GitHub pages, such as
  #756 (a site's sign-in popup opens as a new tab, so the sign-in never returns).

**2. Should the numbers on the sidebar row be clickable too?**

- **No (recommended).** A click on the row selects the workspace today, the numbers hide whole
  in a narrow sidebar (T-GH-03), and the panel is one hover away. No extra code.
- **Yes.** Each number opens its list, by the same rule as question 1, and stops the click
  from selecting the workspace. About +10 lines in `WorkspaceSidebar.tsx:533-548`, plus one
  more e2e step; the numbers become small click targets (10.5 px text) next to the git mark,
  which also opens the panel on hover.

## Facts used

- This change states nothing about what any agent CLI (Claude Code, Codex, Muse Code,
  Antigravity) does. The per-kind rows above rest only on Koloft's own code
  (`sessionBackend.ts`, `agentUi.ts`), read for this design.
- A private GitHub repo answers 404 to a signed-out browser; `github.com/login?return_to=<path>`
  brings the tab to the page after sign-in — `docs/platform-contract.md` §32.
- Open counts come from `gh api graphql` — `docs/platform-contract.md` §32.
- `https://github.com/<owner>/<repo>/issues` is GitHub's issues list: checked with `curl`
  on `superkoh/koloft/issues` (HTTP 200) for this design. `/pulls` is already used by the
  Workbench button (`githubUrl.ts:82-84`, G5 in `test/e2e/github-button.spec.ts`).
- Opening a page from Electron in the system browser goes through `shell.openExternal` —
  `docs/platform-contract.md` §4 (cited at `src/main/osOpen.ts:13`).
- Inferred, not checked: on a remote machine that went offline, the counts leave within
  about 5 minutes (repo and counts cached for `TTL_MS` = 5 min, `github.ts:33`, `:244-249`;
  the sweep drops a `null` answer, `githubCounts.ts:44-45`).
- Inferred, not checked: a second click returns to the same Workbench tab even after the
  sign-in redirect moved that tab to another URL (tabs are matched by `dedupKey` of the
  URL, `workbenchTabs.ts:97-105`; a tab that went through `login?return_to=` may no longer
  match).
- Inferred, not checked: `newSessionInWith(page, 'repo', 'Codex')` starts a Codex session
  in the git fixture workspace the way `startCodex` does in ws-a.

## Tests

Unit:
- `test/unit/github.test.ts:256-262` "sends a click to the pull request, the repository or
  the list" — add `'issues'` → `https://github.com/acme/widgets/issues`; and a case that a
  list target answers without running `rev-parse` (the fake git records its calls).
- `test/unit/workbenchStore.test.ts`, next to `openWebPage` (`:678`): `openWorkspacePage`
  with the selected session in W → a web tab in its Workbench; with a session of another
  workspace selected → the overlay, and that session's Workbench is untouched; with no tab
  → the overlay. (Option B: the last two expect `window.api.browser.openExternal` instead.)

E2E, `test/e2e/workspace-github-counts.spec.ts`:
- **T-GH-01** (`:69-71`) checks the `.fx-counts` text; it changes to the two rows' text
  (`.tbu-act` with "12 open issues", "3 open pull requests").
- **T-GH-06** (`:226`) asserts a remote panel has **no** `.tbu-act`; it changes to "only the
  two list rows — no Pull, no Fetch", and gains a click on "4 open pull requests" with no
  session open → the overlay shows `https://github.com/acme/proj/pulls` (`overlayUrl`,
  `test/e2e/helpers/browser.ts:64-74`).
- **`test/e2e/remote-git-accounts.spec.ts:363`** checks `.fx-counts` contains
  "12 open issues" in a remote panel (Docker SSH lab); it changes to the "12 open issues"
  row.
- **New T-GH-08**: a local Codex session (`installCodex`, then
  `newSessionInWith(page, 'repo', 'Codex')`, `test/e2e/helpers/p1.ts:468` — `startCodex` in
  `helpers/codex.ts:49` is fixed to ws-a) selected in `repo` → click "12 open issues" → the
  panel is gone and a Workbench web tab shows `https://github.com/acme/repo/issues`; a
  second click returns to that same tab. A non-Claude agent is picked on purpose: Claude is
  already the default in every other case.

Fixture URLs skip the sign-in check (`github.ts:288`), so the expected URLs are exact.
Flows to run after the change: `workspace-github-counts`, `github-button` (shares
`target()`), `browser-overlay` (shares `landOverlay`), `git-freshness` and `git-degraded`
(same panel; they read the branch `.fx-counts`, which stays), `git-accounts` (the panel's
account block sits under the new rows), `remote-git-accounts` (line 363 above; needs the
Docker lab).

## Out of scope

- A list of the issues inside Koloft (the C8 New Worktree Session dialog already lists open
  items via `github.openItems` for starting a session from an issue).
