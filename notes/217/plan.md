# #217 plan: pick an element in a Workbench web tab and send it to the session

Mockup: `mockups/217/index.html` (real app DOM + compiled CSS; the page inside the tab
and the highlight are drawn by hand).

## What the owner sees

1. A web tab's address bar gets one new icon button right after the address field
   (`.bnav`, like Back / Reload / Open in system browser). The mockup uses the existing
   "location" icon as a placeholder; a new glyph is drawn by the icon-sheet rule once the
   plan is agreed, and shown old/new before it lands.
2. Click it: the button shows "on" (`.bnav.on`, colour `var(--accent)`, the same look as
   `.icobtn.on`). Hovering the page outlines the element under the mouse with its tag and
   size (Chromium's own inspect overlay). A click picks it and does not reach the page.
   Esc, or the button again, stops without sending; switching tab or navigating stops too.
3. After one pick, picking stops. The pick lands as ONE bracketed paste in the input box
   of the session this Workbench belongs to (`session.tabId`, the same target as ✎ comment
   in `ChangesView.tsx`), unsent, and keyboard focus moves to that terminal. No toast (✎
   comment has none). The owner types the request after the paste and presses Enter; text
   typed after a paste is taken as the person's words (CC§18). This is the path #4 built,
   which the issue asks to share.
4. The button is greyed, with the reason in its tooltip, when:
   - there is no live session, or it waits on a permission question (`commentBlocked` in
     `changesModel.ts`, same messages as ✎ comment);
   - the tab is blank or shows an error page;
   - an agent is driving this tab right now (the tab id is in the store's `cdpAttached`
     for any session): "The agent is using this page". A guest takes only one debugger
     attachment (measured, below), and the relay holds it.

## What the paste holds

```
Element picked in the Workbench browser
Page: <url> ("<title>")
Element: <tag#id.class>, <w> × <h> px at (<x>, <y>)
Picture: <path to PNG>
HTML:
<outer HTML, cut at ~4,000 characters + "… N more characters">
CSS (computed):
<a fixed list of ~20 properties: display, position, width, height, margin, padding,
border, border-radius, color, background-color, font-family, font-size, font-weight,
line-height, flex/grid basics, gap, box-shadow, opacity>
```

## How it works

- Renderer: the button calls a new IPC, `window.api.browser.pickElement(guestId,
  sessionTabId)`; `guestId` is the active `BrowserGuest`'s `getWebContentsId()`.
- Main, new module (e.g. `src/main/elementPick.ts`), on the guest's
  `webContents.debugger`: attach; `DOM.enable`, `CSS.enable`, `Overlay.enable`;
  `Overlay.setInspectMode {mode: 'searchForNode', highlightConfig}`; wait for
  `Overlay.inspectNodeRequested {backendNodeId}`; then `DOM.getOuterHTML`,
  `DOM.getDocument` + `DOM.pushNodesByBackendIdsToFrontend` +
  `CSS.getComputedStyleForNode`, `DOM.getBoxModel`, `Page.getLayoutMetrics`,
  `Page.captureScreenshot {clip}`; `Overlay.setInspectMode {mode: 'none'}`; detach.
- The clip is the box model's border quad **plus** `cssVisualViewport.pageX/pageY`:
  the box model is in viewport coordinates, the capture clip in page coordinates.
- Measured 2026-10-27, Electron 43.8.1 / Chromium 150.0.7871.250, a scratch main script
  with a `<webview>` in a hidden `BrowserWindow`, input sent with
  `Input.dispatchMouseEvent`:
  - every command above answered; `Overlay.inspectNodeRequested` came with a
    `backendNodeId`; the page's own click handler ran 0 times while inspect mode was on;
  - `CSS.getComputedStyleForNode` gave 481 properties;
  - with the page scrolled (scrollY 1040), a clip taken straight from `DOM.getBoxModel`
    (y 500) gave an empty transparent picture; the same box plus `cssVisualViewport.pageY`
    gave the button (centre pixel rgb(10,120,250), as styled);
  - the guest's own `webContents.capturePage(rect)` also worked (400×120 at device scale 2);
  - a second `debugger.attach` on the same guest threw "Debugger is already attached to
    the target".
  These go into PLATFORM§16 when it is built.
- Not probed yet: Esc inside the guest (planned: the guest's `before-input-event` in
  main); a real mouse instead of `Input.dispatchMouseEvent`; elements inside a
  cross-origin iframe.
- Picture file: local tabs → under Koloft's userData (`picks/<tabId>/<n>.png`), removed
  when the tab closes. Remote tabs → copied over the existing ssh master with
  `runSsh(host, 'mkdir -p … && cat > …', {input: png})` (`runSsh` already takes `input`,
  `src/main/remote/ssh.ts`) to `$HOME/.koloft/tabs/<tabId>.picks/<n>.png` (beside
  `REMOTE_TABS_DIR`, `src/main/remote/paths.ts`), and that remote path goes in the paste.
- Paste: the existing `ptyMgr.paste(tabId, text)` (`src/main/ptyManager.ts`).

## Each kind of session tab (4 agents × this Mac / over SSH = 8)

The web tab always runs on this Mac and Koloft does the picking, not the agent, so
#1060–#1062 (remote Codex / Muse / Antigravity cannot drive the browser yet) do not
block it.

| Tab | Text paste | Picture |
|---|---|---|
| Claude Code, this Mac | bracketed paste waits unsent (CC§18, measured) | Mac path; Read opens images |
| Codex, this Mac | same (CODEX§23, measured) | Mac path; Codex lists a `view_image` tool |
| Muse, this Mac | same (MUSE§7, measured) | Mac path |
| Antigravity, this Mac | same (AGY§15, measured) | Mac path |
| Claude Code, over SSH | paste over ssh + tmux measured (CC§18, E-SSH-10) | copied to the machine |
| Codex / Muse / Antigravity, over SSH | the same pty paste ✎ comment uses; not measured per agent | copied to the machine |

Not probed yet: whether each agent opens a picture path that sits inside a paste on its
own, or needs it in the typed words after the paste. Probed on the real binaries while
building; for an agent that does not, the path line moves to the typed-after part.

## Questions for the owner

1. Picture for remote tabs — (a, recommended) copy it to the machine over the open ssh
   link: all eight kinds get the same thing; cost: one ssh write per pick, a few dozen
   lines. (b) Remote tabs get text only: cost: a remote agent never sees the picture.
2. One pick per press (recommended; press again for another, each pick adds one paste)
   vs. staying in pick mode until Esc: cost of the second: easy to send something by
   mistake while trying to use the page.

## Building, once agreed

Files: `BrowserAddressBar.tsx` (button), `WorkbenchPane.tsx` (wire, greyed reasons),
`workbench.css` (`.bnav.on`), preload + shared IPC channel, main `elementPick.ts` (CDP
steps + text), the remote copy, a new icon sheet. Estimate ~200–300 runtime lines.
Tests: unit for the text builder; e2e: a pick on a fixture page in a local Claude tab
(fake-claude keeps a bracketed paste until Enter), a Codex tab, a remote tab (fake-ssh),
and greyed while an agent holds the tab; real-tool smoke for whether each agent opens the
picture.
