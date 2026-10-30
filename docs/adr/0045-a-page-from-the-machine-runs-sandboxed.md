# 0045 A page from an ssh machine runs sandboxed, with no origin of its own

**Constraint**: a web tab shows an `.html` file on an ssh machine through Koloft's own
`koloft-machine://` scheme, which must be a standard scheme so the page's relative
`style.css`, `app.js` and images resolve. A standard scheme gives every page on one machine
the same origin, so without more a page could `fetch()` or read a same-origin frame of any
file on that machine (`~/.ssh/id_rsa`) and send it anywhere. A local page is a `file://`
page: Chromium lets it embed any Mac file but read none.
**Decision**: every response of the scheme carries `Content-Security-Policy: sandbox …`
without `allow-same-origin`. The page then has an opaque origin, as a `file://` page does:
it embeds files from the machine and runs its scripts, but cannot read another file's
bytes. Only a main-frame load, or a load by a page that is itself from the machine, may
ask the scheme for a file, so a web page cannot pull a machine's script into its own
origin; a tab an agent on another machine drives may not load it at all, as it may not
load `file:`; and only a machine of a pinned remote workspace is ever reached.
**Cost**: `localStorage`, IndexedDB and cookies throw or are empty in such a page, while a
local `file://` page has them.
**Rejected**: adding `allow-same-origin` so storage works (it reopens every read above);
serving only files under the workspace root with a real origin (a page could still read
every file of the workspace and of any other workspace on that machine, and `../` out of
the root would break where a local page works).
