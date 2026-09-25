# 0005 Window size and position live in their own file

**Constraint**: main's workspace manager holds `layout.json` in memory and rewrites the
whole file from that copy, on a debounce, whenever a workspace or a session's panel
state changes.
**Decision**: window bounds and the maximized and fullscreen flags go in
`window-state.json`, which only the window code writes.
**Rejected**: a field inside `layout.json` written by the window code — the workspace
manager's next rewrite puts back its own older copy and the bounds are lost.
