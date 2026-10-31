# 0046 localhost in a remote tab's web page is the machine, through a forward on its ssh connection

**Constraint**: an agent on an ssh machine runs `npm run dev` there and says "open
localhost:5173". A web tab draws on the Mac, so without more that address reaches the
Mac's own port 5173 — a wrong page, or nothing. Dev servers and their pages hard-code
`localhost:<port>` (hot reload, API calls), so the page only works if it keeps that
address and port.
**Decision**: the owner chose (2026-10-31) that in every web tab of a session on a machine,
or of a machine workspace's own Workbench, `localhost`, `127.0.0.1` and `[::1]` always mean
that machine. Koloft adds `ssh -O forward -L` on the machine's shared ssh connection, on
both `127.0.0.1` and `[::1]` of the Mac (a browser tries both for `localhost`), when such a
page first asks for the port, with the same Mac port whenever nothing on the Mac holds it
(on any of its four addresses), and another port only then. A forward goes when the last web
page that used it closes, and on quit. The machine's playwright-cli may open and read such a
page only once it came through a forward, never a Mac page it reached some other way.
**Cost**: while a forward lives, every program on the Mac that opens `localhost:5173`
reaches the machine, and a server started on the Mac then finds 5173 taken. A remote tab
can no longer show the Mac's own localhost (a tab of a session on the Mac can). When the
Mac port differs, a page whose code still names the machine's port loses those requests,
its websocket included: Chromium does not redirect a websocket (PLATFORM§12), so it is
refused rather than let through to whatever holds that port on the Mac. The address bar and
the saved tab then show the Mac port, so once that forward is gone (a restart) the tab asks
the machine for that number instead.
**Rejected**: a "Forward a port…" item the owner fills in by hand (an agent's own
`open localhost:5173` would still reach the Mac); waiting for a list of the session's
listening ports (#224), which covers only clicks in that list and would still need this;
always picking a free Mac port (every hard-coded port in the page would break).
