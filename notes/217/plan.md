# #217 plan: pick an element in a Workbench web tab and send it to the session

Mockup: `mockups/217/index.html` (real app DOM + compiled CSS; the page inside the tab
and the highlight are drawn by hand). Checked independently against the code; the
findings are fixed below.

## What the owner sees

1. A web tab's address bar gets one new icon button right after the address field
   (`.bnav`, like Back / Reload / Open in system browser). The mockup uses the existing
   "location" icon as a placeholder; a new glyph is drawn by the icon-sheet rule once the
   plan is agreed, and shown old/new before it lands.
2. Click it: the button shows "on" (`.bnav.on`, colour `var(--accent)`, the same look as
   `.icobtn.on`). Hovering the page outlines the element under the mouse with its tag and
   size (Chromium's own inspect overlay). A click picks it and does not reach the page.
   Esc, the button again, a click outside the page, switching tab or navigating stops
   without sending.
3. After one pick, picking stops. The pick lands as ONE bracketed paste in the input box
   of the session this Workbench belongs to, unsent, and focus goes back to that terminal
   — exactly the ✎ comment path (#4): the renderer calls
   `window.api.terminal.paste(session.tabId, text)` then `onReturnFocus()`
   (`ChangesView.tsx:420-428`). That IPC handler (`src/main/index.ts:5165`) also frees a
   queued background tab and keeps the text for a sleeping tab, so the pick never calls
   `ptyMgr.paste` itself. No toast (✎ comment has none). The owner types the request
   after the paste and presses Enter; text typed after a paste is taken as the person's
   words (CC§18).
4. The button is greyed, with the reason in its tooltip, when there is no live session or
   it waits on a permission question (`commentBlocked` in `changesModel.ts`, the same
   messages as ✎ comment), or the tab failed or crashed (`TabRuntime.fail` / `crashed`,
   `WorkbenchWebGuests.tsx`). An agent driving the same page does NOT grey it (below).

## What the paste holds

```
Element picked in the Workbench browser
Page: <url> ("<title>")
Element: <tag#id.class>, <w> × <h> px at (<x>, <y>)
Picture: <absolute path to PNG, on the machine the agent runs on>
HTML:
<outer HTML, cut at ~4,000 characters + "… N more characters">
CSS (computed):
<a fixed list of ~20 properties: display, position, width, height, margin, padding,
border, border-radius, color, background-color, font-family, font-size, font-weight,
line-height, flex/grid basics, gap, box-shadow, opacity>
```

## How it works

- Renderer: the button calls a new IPC, `window.api.browser.pickElement(guestId)`, which
  resolves with the pick (or nothing when stopped); `guestId` is the active
  `BrowserGuest`'s `getWebContentsId()`. The renderer builds nothing; main returns the
  final text, and the renderer pastes it as in step 3.
- Main, new module (e.g. `src/main/elementPick.ts`), on the guest's
  `webContents.debugger`: `DOM.enable`, `CSS.enable`, `Overlay.enable`;
  `Overlay.setInspectMode {mode: 'searchForNode', highlightConfig}`; wait for
  `Overlay.inspectNodeRequested {backendNodeId}`; then `DOM.getOuterHTML`,
  `DOM.getDocument` + `DOM.pushNodesByBackendIdsToFrontend` +
  `CSS.getComputedStyleForNode`, `DOM.getBoxModel`, `Page.getLayoutMetrics`,
  `Page.captureScreenshot {clip}` with a time limit (a guest with no visible box never
  answers a capture, PLATFORM§9); `Overlay.setInspectMode {mode: 'none'}`. It never sends
  a `*.disable`.
- The clip is the box model's border quad **plus** `cssVisualViewport.pageX/pageY`: the
  box model is in viewport coordinates, the capture clip in page coordinates.
- **One debugger attachment per guest, shared.** A guest takes one
  `debugger.attach` (a second throws). A small holder in main counts who holds each guest
  (the relay's `attachGuest`/`detachGuest` in `cdpRelay.ts` and the picker): it attaches
  on the first hold and detaches on the last release. So when an agent already holds the
  page the picker borrows that attachment and never detaches it, and an agent that
  attaches while a pick is open joins it instead of failing with "already attached".
  The picker's Overlay events also reach the agent's client through the relay's
  `onMessage`; the measurement below shows Playwright does not mind.
- Esc: while picking, the renderer listens for Esc on the window in the capture phase
  (as `BrowserActions.tsx` does), since after the click focus sits on the host button;
  the guest's `before-input-event` covers the case where the page itself has focus.
  Because a click outside the page stops picking, an Esc meant for the terminal is never
  taken.
- Picture file: a new `Host` method (e.g. `savePick(tabId, png): Promise<string>`)
  returns the absolute path the agent can open. `LocalHost` writes under Koloft's
  userData, `picks/<session tab id>-<n>.png`. `SshHost` writes through its own `sh`
  (`remoteShCommand`, as `answerAgent` does, so it runs under `sh` even when the login
  shell is fish, PLATFORM§33) to `$HOME/.koloft/picks/<session tab id>-<n>.png` with the
  PNG on stdin, and prints the absolute path (`cd … && pwd -P`), which is what goes in
  the paste. Nothing on either side cleans a tab's files when it closes today, so each
  save also deletes picks older than a day in the same folder.

## Measured

- 2026-10-27, Electron 43.8.1 / Chromium 150.0.7871.250, a scratch main script with a
  `<webview>` (a real layout box) in a `BrowserWindow` built with `show: false` — not
  the CSS-hidden webview of PLATFORM§9 — input sent with `Input.dispatchMouseEvent`:
  every command above answered; `Overlay.inspectNodeRequested` came with a
  `backendNodeId`; the page's own click handler ran 0 times in inspect mode;
  `CSS.getComputedStyleForNode` gave 481 properties; with the page scrolled (scrollY
  1040) a clip straight from `DOM.getBoxModel` (y 500) gave an empty transparent picture,
  the same box plus `cssVisualViewport.pageY` gave the button (centre pixel
  rgb(10,120,250), as styled); the guest's own `webContents.capturePage(rect)` also
  worked; a second `debugger.attach` threw "Debugger is already attached to the target".
- 2026-10-27, the built app in an e2e run: a real Playwright client attached to a
  Workbench tab through Koloft's CDP relay, then main ran the whole pick above through
  the guest's already-attached debugger (no attach, no detach). Afterwards the client's
  click landed (page click count 1 → 2), an element handle taken before the pick still
  read its text, a locator, a screenshot and a navigation all worked, and the debugger
  stayed attached.
- These go into PLATFORM§16 when built.
- Not probed yet: a real mouse instead of `Input.dispatchMouseEvent`, and whether focus
  comes back to the terminal from a guest that a real click focused (PLATFORM§16: a real
  mousedown makes the guest the window's focused frame) — if it does not, the words the
  owner types next would land in the page; elements inside a cross-origin iframe.

## Each kind of session tab (4 agents × this Mac / over SSH = 8)

The web tab always runs on this Mac and Koloft does the picking, not the agent, so
#1060–#1062 (remote Codex / Muse / Antigravity cannot drive the browser yet) do not
block it.

| Tab | Text paste | Picture |
|---|---|---|
| Claude Code, this Mac | bracketed paste waits unsent (CC§18, measured) | Mac path; Read opens images |
| Codex, this Mac | same (CODEX§23, measured) | Mac path; Codex's tool list has `view_image` (CODEX§16) |
| Muse, this Mac | measured on Linux only (MUSE§7: "Not probed on macOS") | Mac path |
| Antigravity, this Mac | same (AGY§15, measured) | Mac path |
| Claude Code, over SSH | paste over ssh + tmux measured (CC§18, E-SSH-10) | copied to the machine |
| Codex / Muse / Antigravity, over SSH | the same pty paste ✎ comment uses; not probed per agent (CODEX§23: "not probed for Codex") | copied to the machine |

Not probed yet, all checked on the real binaries while building: Muse's paste on macOS;
the paste over ssh + tmux for remote Codex, Muse and Antigravity; whether each agent
opens a picture path that sits inside a paste on its own, or needs it in the typed words
after the paste (for one that does not, the path line moves to the typed-after part).

## Questions for the owner

1. Picture for remote tabs — (a, recommended) copy it to the machine over the open ssh
   link: all eight kinds get the same thing; cost: one ssh write per pick, a few dozen
   lines. (b) Remote tabs get text only: cost: a remote agent never sees the picture.
2. One pick per press (recommended; press again for another, each pick adds one paste)
   vs. staying in pick mode until Esc: cost of the second: easy to send something by
   mistake while trying to use the page.

## Building, once agreed

Files: `BrowserAddressBar.tsx` (button), `WorkbenchPane.tsx` (wire, greyed reasons,
paste), `workbench.css` (`.bnav.on`), preload + shared IPC channel, main
`elementPick.ts` (CDP steps + text), the shared debugger holder used by `cdpRelay.ts`,
`Host.savePick` (local + ssh), a new icon sheet. Estimate ~250–350 runtime lines.
Tests: unit for the text builder and the holder; e2e: a pick on a fixture page in a local
Claude tab (fake-claude keeps a bracketed paste until Enter), a Codex tab, a remote tab
(fake-ssh), and a pick while a Playwright client holds the page; real-tool runs for the
"not probed yet" list above.
