# ext-probes — offline probe extensions for the black-box extension suite

Unpacked MV3 extensions, no build step. Each directory is one behaviour variant named
by the original black-box case list; a spec stages a COPY of one (`stageExtension` in
`test/e2e/helpers/extensions.ts`) so every install gets its own path — and therefore its
own extension id — and so the manifest name / baked config can be rewritten per case.

Nothing here has icon files: a manifest without `default_icon` is valid, and the action
row is located by `aria-label`, never by pixels.

| dir | what it does | cases |
| --- | --- | --- |
| `base` | content script marks the page root with `data-koloft-bb-probe=<runtime.id>`; action with a popup page | M01–M08, M11, C01–C06, C09, N02 |
| `popup-browser-ns` | popup script reads `browser.runtime.id` at top level, then marks its own document | C13 |
| `sw-browser-ns` | service worker reads `browser.windows.WINDOW_ID_NONE` at top level, then sets badge `ok` | C07 |
| `tabs-create` | action click → `chrome.tabs.create` on the url baked into `config.js` | M10 |
| `ext-page` | action click → `chrome.tabs.create` on its OWN extension page, which marks its document | C15 |
| `active-tab` | action click → queries the active tab and puts its hostname in the badge | C11 |
| `permissions` | action click → `chrome.permissions.request` of an optional permission, result in the badge (`y`/`n`) | C08, C14, N01 |
| `storage-rw` | content script writes on `#write`, reads back into `data-koloft-bb-storage` on `#read` | C12 |
| `storage-sync` | content script round-trips a value through `chrome.storage.sync`, marks `data-koloft-bb-sync=ok` | C16 |
