# 0012 The island focus ring comes from CSS `:focus-within`

**Constraint**: many things take the focus by their own routes — a web page guest, the
terminal, the address field, the panel root. Each would have to report in if the app
kept its own copy of where the focus is.
**Decision**: the ring is plain CSS (`:focus-within`); the browser already knows where
the focus is. The one hole, a focused `<webview>` (PLATFORM§10), is patched with a
`.caret` class that App sets.
**Rejected**: a "which island has the focus" value in the store that draws the ring —
a second copy of the focus can only drift from the real one, and no test would notice.
