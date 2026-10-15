# Plan: tooltips never show on the Workbench tab strip (#27)

Checked against the code on `main` (d5207a0d) by an independent reviewer three times (first draft 7 points, which asked for the VM measurement below; then 7 points on option A's traps); all are folded in.

## Measured (2026-10-15)
A throwaway tart VM (macOS 27.0, 26A428), a minimal Electron 43.7.3 app (Chromium 150.0.7871.250, the version in Koloft's `package-lock.json`), `titleBarStyle: 'hiddenInset'` like Koloft. The real mouse moved there with `CGEventPost` (PLATFORM§52), waited 2 s; a tooltip was counted when a level-103 tooltip window owned by Electron was in `CGWindowListCopyWindowInfo` (checked against screenshots both ways). A fresh app per run, 8 hovers per run.

| Element | Tooltip shown |
|---|---|
| plain `<button title>`, mouse at its centre | 1 of 8, 5 of 8, 1 of 8 in three runs |
| the same, mouse at its very left or right edge | 24 of 24 |
| `[title]{position:relative}[title]::after{content:'';position:absolute;inset:0}` | 16 of 16 |
| that, with `pointer-events:none` on the `::after` | 6 of 16 |
| a `no-drag` button inside a `-webkit-app-region: drag` bar | 16 of 16 |

So: electron/electron#49843 is real on 43.7.3 and hits every `title` in the app, randomly (not "first hover only"); the drag region is not the cause; the CSS cover from that issue's thread fixes it. Why the strip seems worse than elsewhere (the owner saw none at all there) is inferred, not checked: its buttons are small, so the mouse is nearly always near the centre. Script, logs and screenshots: `notes/27/` on branch `fix/27-tooltips`.

## Markup today
The strip's buttons carry `title` (`WorkbenchPane.tsx` ~1674, 1710, 1721, 1799, 1862: Files tab, web tabs, GitHub button `.wb-gh`, `＋` `.wb-new`, close `.x`, mute `.btab-spk`); the strip is one component for all four kinds of session tab (`App.tsx` ~1795). The app has ~146 `title` sites in the DOM.

## Options
- **A (recommended): keep macOS's own tooltips and add the measured CSS cover app-wide.** Four or five CSS rules, cited `/* PLATFORM§24 */` with the measurement recorded there:
  1. the cover, at zero specificity: `:where([title])` gets `position: relative` and an `::after` with `inset: 0`, so any element that already sets `position` keeps it (checked: no absolutely placed child re-anchors);
  2. one lift rule for everything clickable or titled inside a titled element: `:where([title]) :where([title], button) { position: relative; z-index: 1 }` — needed because 7 kinds of titled container hold ~22 such children (web tabs with ✕ and mute, sidebar rows and workspace headers with their icons and buttons, Browse and Changes rows, world-clock chips, recent-session rows); without it their clicks and hover cards would land on the parent;
  3. `isolation: isolate` on titled parents, so a lifted ✕ cannot paint over the sticky pinned Files tab when tabs scroll under it;
  4. a short `:not(...)` list for the four titled elements that already draw an `::after` (`.tb-ico` unread dot, `.side-grip`, `.fv-gutter`, `.switch`) — those four keep today's flaky tooltip.
  Text inside a titled span (Workbench path titles, search hits) can no longer be selected with the mouse. A nested cover with a lifted child was not run in the VM (not probed yet); Playwright's click hit-check turns the strip's close and mute e2e red if a lift is missing. No `title` moves, so e2e cases that read `title` stay as they are.
- **B: the same CSS, only on the Workbench tab strip** (`.wb-tabs`). Cost: tooltips everywhere else stay at about 1 in 3; the strip still needs the lift and isolate rules (its tabs hold ✕ and mute).
- **C: Koloft draws its own tooltip for every `title`** (mockup `mockups/27/index.html`). ~55 lines of JS; reads `title` live on hover, does not move it. Cost: every tooltip in the app changes look; guest web pages keep the native, flaky ones.
- **D: no tooltip fix; a visible ▾ on the GitHub button.** Cost: a busier, wider strip; nothing else explains itself on hover.

## Question for the owner: how should Koloft fix its tooltips?
- **A (recommended): keep macOS's own tooltips everywhere, with the measured CSS fix.** Cost: 4–5 CSS rules that touch every element with a tooltip; four elements keep today's flaky tooltip; text inside a few titled labels can no longer be selected with the mouse.
- **B: the same fix, only on the Workbench tab strip.** Cost: tooltips elsewhere keep showing about one hover in three.
- **C: Koloft draws its own tooltips.** Cost: every tooltip looks different from macOS's; more code.
- **D: no tooltip fix; a ▾ on the GitHub button.** Cost: a busier strip, and nothing else on it explains itself.
