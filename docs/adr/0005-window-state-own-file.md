# 0005 Window size and position live in their own file

**Constraint**: the renderer rewrites `layout.json` whole on every (debounced) tab
change.
**Decision**: window bounds and the maximized and fullscreen flags go in
`window-state.json`, which only main writes.
**Rejected**: a field inside `layout.json` — main's writes would race the renderer's
full rewrites and be lost.
