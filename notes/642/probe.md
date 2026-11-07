# #642 probe: what a closed and reopened Koloft window gives back

Measured 2026-11-07 on `main` at `ed0fc409`, with the e2e harness (hidden window, fake
`claude`). The spec is at the end of this page; it was run twice.

## The case

```
owner at the Mac          Koloft main process            Koloft window (renderer)
-----------------         -------------------            ------------------------
clicks the red button --> mainWindow = null  ----------> gone: every terminal view,
                          ptys keep running              every Workbench web page
                          Discord keeps working
(owner leaves)
Discord: "screen of X" -> screenOf(): "the Koloft
                          window is closed ..."
```

Session A (ws-a) and session B (ws-b), each with one Workbench web page open
(`/a-page`, `/b-page` on a local server). B is on screen. B runs a loop that calls
`koloft session screen <A>` every ~0.5 s and writes what it gets to a file. Then the
window is closed, and 3 s later `app.emit('activate')` opens a new one (the same
`createWindow()` a Dock click or a notification click runs).

## What was measured

### Screen reads (`koloft session screen`)

| moment | what the read returned |
| --- | --- |
| window closed | `the Koloft window is closed, so its screen cannot be read until it opens again.` |
| read sent just before the new window loaded (run 1: 0.01 s before `activate`) | `the Koloft window did not show its screen.` after the 3 s budget: the request went to a window that was not listening yet |
| first read after the new window loaded (run 2: 0.46 s after `activate`, 0.18 s after it booted) | the redrawn frame: `[fake-claude] winch 69x48` and the prompt, plus the note `The Koloft window was opened again after this session started, so the screen holds only what came after that.` |
| any read later | the same frame. Everything printed before the close (`marker-before-close`) is gone |

- The new window adopts the running ptys the same way a reload does (`CH.tabs.inventory`,
  `index.ts` around line 6540), and shrinks each agent pty by one row (ADR-0007). That
  one resize is what makes the agent redraw, so the screen holds one fresh frame.
- A tab not on screen stays at that shrunk size (`69x48` for A, while B fitted back to
  `69x49`) until someone looks at it. The read still works; its note says lines may wrap
  at a different width.
- The fake `claude` only prints a `winch` line on a resize. A real Claude Code redraws
  its whole screen on a resize (ADR-0007, measured for a reload, which runs the same
  path). Codex, Muse and Antigravity redrawing the same way: inferred, not checked
  (ADR-0007 already says so for Codex).

### Workbench web pages

| moment | live web pages (Electron `webview` contents) | web tabs in the Workbench tab strip |
| --- | --- | --- |
| before the close | 2 (`/a-page`, `/b-page`) | 1 for B |
| window closed | 0 | (no window) |
| 0 – 20 s after the new window loaded | 0 | 1 for B (saved by address in layout.json) |
| after switching to session A | 0 | 1 for A |
| after clicking A's web tab | 1 (`/a-page`), and the server saw a second request | 1 for A |

- Closing the window destroys every web page. The new window brings back each
  session's web tabs **by address only**, and loads a page only when someone looks at its
  tab. Anything typed into a page, a half-done sign-in, and the page's place are gone.
- So right after a reopen `koloft secret page` still finds no page (it only looks at
  live pages, `guestPagesOf`), until the tab is looked at.
- playwright-cli: the relay lists the tabs the window reports and can ask the window to
  load one (`mount` in `cdpRelay.ts`), so it would likely reach a reloaded page once the
  window is back. Inferred from the code, not probed.

## What this means for a fix

Every "open the window again when Discord needs it" fix gives back a lossy result: a
screen with no history, and pages reloaded from their address. The only way that loses
nothing is to not destroy the window when the owner clicks the red button. Which of these
to do changes what the owner sees, so it waits for the owner (see the issue's progress
comment).

What "the red button only hides the window" has to handle, found in the code:

- There is no `close` handler on the window today, only `closed`. A `close` that hides
  must let a real quit through (`quitCommitted`), or ⌘Q never ends.
- `app.on('activate')` creates a window only when none exists; a hidden one still counts,
  so a Dock click has to show it instead.
- ⌘Q while hidden: the unsaved-edits question goes to the hidden window
  (`askQuit` → `App.tsx`), nobody sees it, and the 5 s fallback (`quitGuard.ts`) quits and
  drops the unsaved edits. Today a closed window means Koloft quits at once. The window
  has to show itself before asking.
- Background throttling is on in the shipped app (PLATFORM§5): a hidden window draws
  nothing and acks terminal output slowly, the same as a minimized window today.
- A sign-in popup (`signInWindow.ts`) is its own window and still appears while the main
  window is hidden; `keptBySignInWindow` also shows the main window.
- Scheduled tasks wait for a window (`cronRunner` `ready`): today a closed window holds
  them back; a hidden one lets them run.
- T-REL-05 (`reload-recovery.spec.ts`) asserts that a close and an `activate` build a new
  window; it changes with this option.
- Window size saving (ADR-0005) is not affected.

## Eight tab kinds

All eight (Claude Code, Codex, Muse Code, Antigravity; each local and over SSH) read
their screen through the same window, so all eight lose the same way today and would gain
the same way from any option. Two named differences:

- A remote tab's terminal is a tmux client. tmux repaints the whole pane on a resize, so
  after a reopen a remote tab likely comes back with its whole pane, where a local one
  shows only what the agent redraws. Inferred, not checked.
- Discord's `/run`, `/compact` and other slash commands read the screen too: for every
  agent to check that the typed Enter landed and whether anything came back
  (`discord/slash.ts`, `checkTheEnterLanded`, `nothingCameBack`), for Codex and Muse to
  see whether a panel is open, and for Antigravity to read the command's output
  (AGY§23). With the window closed those reads fail quietly. Only Claude Code's panel
  check reads its session registry instead of the screen.
- These numbers come from the e2e window, where background throttling is off
  (`BACKGROUND_TEST`, PLATFORM§5). How fast a hidden window answers a screen read in the
  shipped app, where throttling is on, is not probed yet.
- The read waits for the window to listen: the renderer listens for screen requests only
  once its first terminal view is mounted (`terminalScreens.ts`), and answers `null` for a
  tab whose view is not mounted yet. So a reopen step has to wait for that tab's terminal
  to attach (`CH.terminal.attach`), not just for the window to load.

## The probe spec

```ts
import fs from 'fs'
import path from 'path'
import { test, expect } from './helpers/app'
import { startEchoServer } from './helpers/fixtureServer'
import { centerTerm, runIn, startSessionIn, switchToRow, terminalText, waitBooted, waitForCalls, wsRows } from './helpers/p1'
import { BROWSER } from './helpers/browser'
import { wbTabs } from './helpers/workbench'

const SCRIPT = `#!/bin/sh
i=0
while [ $i -lt 14 ]; do
  printf -- '--- %s\\n' "$(perl -MTime::HiRes=time -e 'printf "%.2f", time')"
  koloft session screen "$1" 2>&1 | tail -n 6
  i=$((i+1))
  sleep 0.4
done
`

const webviews = ({ webContents }) =>
  webContents.getAllWebContents().filter((w) => w.getType() === 'webview').map((w) => w.getURL())

test('probe 642', async ({ app, page, env }) => {
  const server = await startEchoServer()
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const [a] = await waitForCalls(env, 1)
  await runIn(page, centerTerm(page), 'marker-before-close')
  await runIn(page, centerTerm(page), `/open ${server.page('/a-page', '<title>A page</title><input id="pw" type="password">')}`)
  await startSessionIn(page, 'ws-b')
  await waitForCalls(env, 2)
  await runIn(page, centerTerm(page), `/open ${server.page('/b-page', '<title>B page</title><input id="pw" type="password">')}`)
  const script = path.join(env.home, 'probe-screen.sh')
  const out = path.join(env.home, 'probe-screens.txt')
  fs.writeFileSync(script, SCRIPT, { mode: 0o755 })
  await runIn(page, centerTerm(page), `/later /sh ${script} ${a.sessionId} > ${out} 2>&1`)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  fs.writeFileSync(path.join(env.home, 'go-later'), '')
  await new Promise((r) => setTimeout(r, 3000))
  const opened = app.waitForEvent('window')
  await app.evaluate(({ app }) => app.emit('activate'))
  const reopened = await opened
  await waitBooted(reopened)
  // poll app.evaluate(webviews) for 20 s, read the tab strip, switch to A,
  // click wbTabs(reopened).nth(1), read app.evaluate(webviews) and server.count again,
  // then print the file at `out`.
})
```
