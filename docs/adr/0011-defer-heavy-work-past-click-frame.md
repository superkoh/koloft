# 0011 Collapsing the panel paints the width change first; hiding its content waits two frames

**Constraint**: heavy rendering in the same React commit as a click holds the screen
until it ends. Measured: 220–310 ms collapsing a panel that shows a big diff.
**Decision**: the collapse click's commit changes only the column width. Telling the
panel it is hidden (`panelVisible`) waits two `requestAnimationFrame` calls, and a
collapsed panel keeps its content laid out at its last shown width (`--wb-w` /
`shownWidth`). Expanding is never delayed, because `focus()` does nothing inside a
hidden subtree.
**Rejected**: driving the panel's visibility straight from `panelShown` in the click's
commit, and laying a collapsed panel out at width 0 — both put the heavy work before
the first paint.
