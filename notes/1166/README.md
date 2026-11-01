# #1166 probe, 2026-11-01

`probe-1166.spec.ts` copied into `test/e2e/` and run with
`npx playwright test test/e2e/zz-probe-1166.spec.ts --workers=1` after `npm run build`.
It follows T-LIFE-14 (start "Remove me", `/open` a page, SIGKILL the fake claude), then
every 100 ms prints `window.api.workspace.rows()` `running` for the session, the session's
`alive` in `window.api.sessions.list()`, and the sidebar row's classes; then it presses
Close on the kept tab and samples 1.5 s more.

Result, same on `origin/main` ec15b5b (twice) and on 6781fe96 (the #1172 merge):

    before    0 ms  rows [true]   alive true   "ws-tab st-waiting active"
    killed  115 ms  rows [true]   alive false  "ws-tab cold active"
    killed  325 ms  rows [false]  alive false  "ws-tab cold active"
    ... rows [false] for the rest of the 4 s the tab is kept ...
    closed 4202 ms  rows [false]  (session gone from the list)  "ws-tab cold"
    ... "ws-tab cold" in every sample after Close, never st-idle ...

So main's rows drop `running` about 0.3 s after the kill (the rescan after the tracker
marks the tab dead on `teardown`), and the row never paints live after Close.
