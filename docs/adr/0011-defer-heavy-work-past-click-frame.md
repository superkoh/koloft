# 0011 A click's frame shows only the cheap change; heavy work waits two frames

**Constraint**: heavy rendering in the same React commit as a click holds the screen
until it ends. Measured: 0.1–0.8 s switching to a CJK-heavy xterm at 2560×1440
(PLATFORM§21), and 220–310 ms collapsing a panel that shows a big diff.
**Decision**: the click's commit changes only the row highlight, a loading mask, or the
column width. Showing the target xterm and panel (`shown`), telling the panel it is
hidden (`panelVisible`), and dropping its content wait two `requestAnimationFrame`
calls. A collapsed panel keeps its content at its last shown width (`--wb-w` /
`shownWidth`). Expanding is never delayed, because `focus()` does nothing inside a
hidden subtree.
**Rejected**: driving the panel and xterm straight from `activeTabId` / `panelShown`
in the click's commit, and laying a collapsed panel out at width 0 — both put the heavy
work before the first paint.
