# Platform contract ledger

Measured facts about the platforms Koloft runs on or talks to — Electron, Chromium,
Node, macOS, git, the shell, GitHub — that Koloft depends on and that **reading
Koloft's own code cannot reveal**. Claude Code and Codex have their own ledgers. Each
entry says how it was established; a disproven entry is corrected in place, never kept
for history. Code cites a section with a `// PLATFORM§N` marker.

**How to read "how established"**: the entries below were moved here from code
comments Koloft had carried for a while. When a bullet names no date, version or
method, it comes from those earlier Koloft code notes and was **not re-measured** when
it moved here. A bullet that says "measured" or "seen" repeats what the old note said
about how it was found.

## §1 macOS: the environment of an app opened from Finder

- A packaged app opened from Finder or the Dock gets launchd's short environment, not
  the user's shell one. PATH is only `/usr/bin:/bin:/usr/sbin:/sbin`: `git` is there,
  but Homebrew tools like `gh`, and a `claude` found on a developer's PATH, are not. A
  `git` or `gh` run by name from such an app can fail with no error shown.
- No locale is set either, so a shell started from the app runs in the C locale: CJK
  text is garbled and wcwidth counts a wide character as 1 cell, which breaks the
  layout of Claude Code's TUI (text user interface).

## §2 Shells: login shells, PATH order, bash, and OSC 7

- **A login shell moves `/usr/bin` to the front.** On macOS a login shell runs
  `path_helper`, which puts `/usr/bin` and the other system folders ahead of the PATH
  the parent handed it. A fake binary (for example a test's fake `open`) placed early
  on the inherited PATH loses to the real `/usr/bin` one inside a session pty, unless
  its folder is put first again after the rc files have run.
- **`zsh -lc` skips `~/.zshrc`** (a login shell that is not interactive). A check that
  used it reported "no claude" for a claude that every session found. Only `zsh -l -i`
  loads the user's full profile.
- **Apple Terminal's OSC 7.** With `TERM_PROGRAM=Apple_Terminal`, macOS `/etc/zshrc`
  sources `/etc/zshrc_Apple_Terminal` (bash does the same through
  `/etc/bashrc_Apple_Terminal`). Its precmd hook writes
  `ESC ] 7; file://<host><percent-encoded path>` (ended by BEL or `ESC \`) at every
  prompt and `cd`. The path encodes every character except `[/._~A-Za-z0-9-]`, but the
  host is put in unencoded, so it can hold spaces and an apostrophe ("Ada's MacBook
  Pro"). The same script's per-session history block (`~/.zsh_sessions`) turns on only
  when `TERM_SESSION_ID` is set, and Terminal.app, iTerm and VS Code all set it, so an
  inherited value turns it on. node-pty reports nothing on `cd`, so OSC 7 is the only
  way to follow a plain shell's folder. (The old note says the format was "verified on a
  real pty"; no date or macOS version.)
- **bash `$!` and the subshell fold.** After `( … ) &`, `$!` is the subshell's pid. Bash
  folds the subshell into its last command only when that command stands alone; a
  `umask` before it prevents the fold. Without `exec`, killing `$!` kills only the
  wrapper and leaves the real child (for example `security` holding a Keychain dialog)
  running.
- **A non-interactive bash gives a background job `/dev/null` as stdin.** `<&0` is
  needed to pass the real stdin through.

## §3 macOS system tools and limits

- **`caffeinate` versus `powerSaveBlocker`.** Electron's `powerSaveBlocker` covers only
  display sleep and idle sleep, not disk sleep. `caffeinate -m` also blocks disk idle
  sleep, and `caffeinate -dims -w <pid>` exits when that pid exits — the kernel enforces
  it, so a crashed or SIGKILLed app never leaves a stray `caffeinate`. `caffeinate`
  exists only on macOS.
- **macOS has no `timeout(1)`**, and `/usr/bin/security` waits on a GUI unlock or
  authorization dialog with no timeout of its own. A time limit in a shell script has to
  be a `kill -0` polling loop.
- **The Keychain items Koloft writes trust `/usr/bin/security` in their ACL**, so any
  process running as the user can read them all, whatever the service name, and a real
  authorization prompt does not show up in normal use. A per-build service name keeps
  builds apart; it is not a security line.
- **`lsof` exits 1** whenever one of the pids it was asked about has nothing to show,
  while still printing the rest.
- **macOS `tar` adds AppleDouble `._name` files** next to every file with an extended
  attribute (a quarantine flag is enough); `COPYFILE_DISABLE=1` turns this off. Pushed
  to another machine, claude reads `._settings.json` as a second, broken settings file.
  (Reproduced in a unit test with `xattr -w` and real macOS tar.)
- **A copy of a signed system binary saved under another name is SIGKILLed** when run.
- **A file downloaded by Node has no `com.apple.quarantine` flag**, so an app installed
  from it opens without Gatekeeper. The official `install.sh` relies on the same fact.
- **A launch in roughly the first half-minute after wake fails**: the network, the
  Keychain and file watches all need a moment to come back.
- **A unix socket path is capped at 104 bytes** (`sun_path`). `os.tmpdir()`
  (`/var/folders/…`) already uses most of that, and a path under the app's userData
  folder is too long.
- **`fsync` does not flush the drive's cache on macOS**; that needs `F_FULLFSYNC`,
  which Node does not expose, so written bytes can still be lost in a power cut.
- **`os.tmpdir()` is a symlink**: it hands out `/var/folders/…`, whose realpath is
  `/private/var/folders/…`. A temp-folder check has to compare realpaths on both sides.
- **pids are reused within one e2e suite run** (measured: one pid served two different
  workers' sessions three minutes apart), so a pid read from a file minutes earlier may
  belong to another process.
- **On a network share or exFAT, mtime is only precise to 1–2 s.** An edit that keeps
  the same size inside one clock tick changes neither mtime nor size.

## §4 Electron: app identity, packaging and opening things

- **userData comes from package.json `name`**, so the packaged app and an unpackaged dev
  run share one folder unless `app.setName()` runs before the first
  `app.getPath('userData')`. electron-builder's `extraMetadata.name` changes the same
  field. On macOS userData comes from the real user Library, not from `$HOME`, so
  isolating it needs `--user-data-dir` as well as a fake `$HOME`.
- **An unpackaged run reports Electron's version** from `app.getVersion()`, not the
  app's. A bare `electron out/main/index.js` launch reports `out/main` as
  `app.getAppPath()`.
- **Only Electron can open files inside `app.asar`.** bash or node must use the
  `asarUnpack`'d copy under `app.asar.unpacked`.
- **`app.setActivationPolicy('accessory')` must be set before any window exists**, or
  the first window show still makes the app active and takes focus.
- **A Notification that nothing holds on to can be garbage-collected** while its banner
  is still in Notification Center; its `click` handler then never fires.
- **`shell.openPath` and `shell.openExternal` go through LaunchServices, not PATH**, so
  a fake `open` on PATH cannot catch them. `openPath` does not reject on failure: it
  resolves with an error string (empty on success). `openExternal` and
  `showItemInFolder` report nothing like that.
- **An unhandled promise rejection in main** (Koloft has no `unhandledRejection`
  handler) becomes Electron's native "A JavaScript error occurred in the main process"
  dialog.

## §5 Electron: windows, renderers and quitting

- **A destroyed window or WebContents throws "Object has been destroyed"** on use:
  `BrowserWindow.webContents` is a getter that throws, `webContents.send` throws, and
  every getter (such as `getURL`) throws inside a `destroyed` handler (measured for
  `getURL`). A throw inside a timer callback in main crashes main. The BrowserWindow
  object outlives its webContents, so a null check on the window is not enough.
- **`maximize()` shows a window that was created hidden** (macOS).
- **`setBounds` throws** if any value is NaN.
- **Passing `fullscreen: false` when building a BrowserWindow turns off the green
  fullscreen button** on macOS: it only zooms, and `isFullScreenable()` is false. Leave
  the key out unless it is true.
- **Construction bounds are clamped up to `minWidth`**, so a saved window narrower than
  the minimum is widened unless the minimum is lowered to match.
- **`backgroundThrottling: false` keeps a hidden window running**: rAF and timers keep
  going and Page Visibility stays `visible`. Without it Chromium slows timers in a
  hidden or minimized window (so a renderer's acks slow down) and xterm, which draws on
  rAF, stops drawing. In a window that is never shown, the next animation frame can
  still take a long time to arrive.
- **After `render-process-gone` Electron does not reload the window by itself**; it stays
  dead until main calls `webContents.reload()`.
- **`did-start-navigation` for a hard reload fires while the OLD document still runs**,
  and it keeps running until the new one commits. Messages sent in that gap are handled
  by the old page (one saved an empty strip over the state the next renderer was about
  to restore).
- **Every page a `<webview>` loads fires the host's `did-start-loading`**, because a
  guest is a frame of the host document. Only a main-frame, cross-document
  `did-start-navigation` means the host page itself is changing.
- **`before-quit` cannot wait.** It must allow or block the quit synchronously, so
  asking the renderer first means: block, ask, then quit again once the answer comes.

## §6 Electron: IPC

- **`webContents.send` before the renderer listens is lost, and still reports
  success.** It is not queued. Measured: about 6% of opens handed over at app start
  were lost under load, and every one sent before launch.
- **An Error thrown in an `ipcMain.handle` handler reaches the renderer without its
  `code`**; only the message survives, wrapped as
  `Error invoking remote method '<channel>': Error: <original message>` (the original
  text follows the last `Error: `).

## §7 Electron: menus and keys

- **Role-built menus cannot be edited and clash with Koloft's keys.** A submenu built
  from a role (appMenu, editMenu, viewMenu) cannot take extra items. The default
  File/windowMenu role binds ⌘W to Close Window; the viewMenu role's Force Reload binds
  ⇧⌘R. Reload, zoom and DevTools roles act on the whole focused window renderer, not on
  a focused `<webview>`, so a role-based ⌘R inside a web page would reload Koloft and
  kill every terminal. The built-in zoom roles step by 0.5 and clamp to Chromium's
  range of -8 to 9.
- **A menu accelerator is handled natively, before the page.** It fires even while
  xterm has focus (a plain renderer keydown listener is swallowed by xterm), and it
  takes its key before a focused guest page or xterm can see it. ``"Control+`"`` parses
  on every platform.
- **Keys typed in a focused `<webview>` never reach the host document's listeners**,
  capture phase included, and a focused guest swallows the app's menu accelerators;
  keys with no accelerator (⌘T) never reach the host at all. Main has to catch them on
  the guest's own `before-input-event`.
- **`before-input-event` is fed by native input only.** A key event sent straight into a
  guest's render process, or typed inside an extension's action popup, never passes it;
  only `input-event` sees an injected one. A key that `before-input-event` does not
  `preventDefault` still reaches `input-event`.

## §8 `<webview>`: attach, load and lifecycle

- **A fresh `<webview>` cannot answer questions right after attach** (electron#31918).
  Calls made before attach are silently lost. `getWebContentsId()`, `canGoBack()`,
  `getURL()`, `loadURL()` and the rest THROW synchronously (no rejected promise, no
  `did-fail-load`) until a few ms after `did-attach`; reading the id once at attach
  gives 0 or throws, so it has to be polled. The element is usable at `dom-ready`.
  Optional chaining does not help — it guards a missing method, not a throw.
  `did-attach` fires before the element can name its guest, so `setAudioMuted` there
  throws and breaks the load that follows.
- **A fresh guest boots on `about:blank`, then loads its real URL.** When the first
  `loadURL` throws (measured: about 1 mount in 3), the real load starts again at
  `dom-ready`, and `about:blank`'s own `did-stop-loading` lands about 3 ms before it
  (another measurement: +394 ms, with the real load still going). A CDP client handed
  the page at that stop gets it about 170 ms before the real page commits.
- **`loadURL()` rejects when a navigation is aborted** (a redirect away, a Stop, a URL
  that becomes a download). Real load failures come through `did-fail-load`.
- **`src` stays at the boot `about:blank` after `loadURL`**; only `getURL()` tells the
  page shown.
- **A `<webview>` with no `partition` quietly uses the default session**, and nothing
  errors.
- **Popups**: without the `allowpopups` attribute (`disablePopups` true) Electron drops
  `window.open` in the browser process, before any window-open handler runs (SEC-7
  spike). The `webPreferences` in `will-attach-webview` carry `disablePopups` and can
  carry `allowFileAccessFromFileUrls`; neither is in Electron's typings. Its `params`
  always carry a `disablewebsecurity` key, even for a guest that never asked, and
  attribute values arrive as strings, so only `String(value) === 'true'` means it is set.
- **Zoom**: a guest takes on its embedder's zoom (measured: window and guest go 1 →
  1.0954 together). `getZoomFactor()` answers 1 until the guest's IPC has been used at
  least once (measured), so the guest's own `innerWidth` is the reliable signal.
- **DevTools**: the element's own `openDevTools()` cannot be told to leave focus alone.
  When DevTools opens, its `devtools://` webContents appears first and
  `isDevToolsOpened()` turns true a moment later (measured).
- **HTML fullscreen**: a guest asking for it puts the whole host WINDOW into macOS
  fullscreen, its own Space (measured, 2026-08-18 spike). `leave-html-full-screen`
  arrives only while the guest is alive, so closing a fullscreen page never sends it.
  Measured 2026-09-23 on Electron 43.7.3, with a probe spec reading the window's
  state and events:
  - The request goes through the session's permission request handler as
    `fullscreen`. Inside `callback(true)`, `enter-html-full-screen` fires and the
    window's resize is decided, all before the callback returns. The native
    `enter-full-screen` lands about 800 ms later, so checking `isFullScreen()` in
    `enter-html-full-screen` cannot catch it.
  - A window with `setFullScreenable(false)` at that moment keeps its size and
    state: the page still goes fullscreen inside its `<webview>`, the promise
    resolves, and leaving works. This holds whether the window was windowed, already
    in system fullscreen, or hidden.
  - `disableHtmlFullscreenWindowResize` changes nothing, set on the guest or on the
    host window.
  - A hidden window that is allowed to follow the guest shows itself.

## §9 `<webview>`: visibility, frames and capture

- **`display:none` detaches a `<webview>`, and it reloads when shown again**
  (electron#28677); while hidden its rAF freezes and `visibilityState` sticks. Moving it
  among its siblings in the DOM also re-attaches and reloads it. `visibility:hidden`
  keeps it alive.
- **A guest makes frames only while it has a real, visible layout box.** With no box,
  with `visibility:hidden`, or in a zero-width column, it produces no frames, and CDP
  `Page.captureScreenshot` on it never answers — it hangs rather than fails (measured).
  A `<webview>` mounted while hidden, or into a zero-width column, never reaches
  `did-attach` (measured: the mount timed out). Input commands still land on a hidden
  guest (measured). A capture that races the first paint comes back empty.
- **Host captures do not draw a guest.** Neither Playwright's `page.screenshot()` of the
  host nor `win.capturePage()` shows any trace of a `<webview>` filling the area.

## §10 Focus between the host page and a `<webview>`

- **A focused `<webview>` is invisible to the host's focus tools** (measured on
  Electron 43, T-FX-01's probe). After a click inside a guest, the element becomes the
  host's `document.activeElement` but matches neither `:focus` nor `:focus-within`, and
  no focus event fires in the host; the guest's webContents fires neither focus nor
  blur. `focusout` fires while the old element is still active.
- **While a guest holds the caret, the host's `document.hasFocus()` is false** on a real
  window (measured in a manual round), and window `blur`/`focus` fire for that
  hand-over; only main's BrowserWindow focus events tell "went into a page" from "left
  the window".
- **With the app hidden or offscreen (`KOLOFT_TEST_BACKGROUND=1`), `hasFocus()` is true
  in several documents at once** (three in the specs), so only `activeElement` shows
  which surface holds the keyboard.
- **Chromium fires no `blur` when the focused element is removed**, nor when it is only
  hidden: `activeElement` quietly becomes `<body>`, or for a guest stays with a page
  nobody can see.
- **While the pointer is over a guest (or an xterm canvas) the host gets no
  `mousemove`**, so a drag needs a transparent fixed overlay.
- **An HTML drag with no `dataTransfer` payload fires no `dragover`**; at least one
  `setData` call is needed.

## §11 `<webview>` guests: permissions

Unless marked otherwise, from the 2026-08-18 spikes run against this app's own Electron.

- **The handler's `origin` argument is empty**; the asking site is only in `details`
  (`requestingUrl` / `securityOrigin` / `embeddingOrigin`).
- **Microphone and camera arrive as ONE permission, `media`**, told apart by
  `mediaTypes` (request handler) or `mediaType` (check handler). `getDisplayMedia`
  arrives as `media` with empty or missing `mediaTypes`, not as `display-capture`
  (measured, "not documented anywhere"). A denied permission reaches the page as a
  real error, not a hang — except a refused `getDisplayMedia()`, whose promise never
  settles (no measurement given).
- **Refusing `fullscreen` stops `enter-html-full-screen` from ever firing**, which turns
  page fullscreen off entirely (measured).
- **A session with no request handler grants everything**, so a page could open the
  camera on load. **A callback that is never called** holds the request and its
  WebContents for the life of the process, and the page's call waits forever.
- **Granting `openExternal` makes Electron call `shell.openExternal` itself**, skipping
  any allowlist the app checks; the target is in `details.externalURL`. Chromium gives
  that request no user-gesture flag; its own transient user activation lasts 5 s.
- **`setPermissionCheckHandler` is what `Notification.permission` and
  `navigator.permissions.query()` read**, on page load, with no user action behind it.
- **With no audio or video input device, `getUserMedia` rejects with `NotFoundError`
  before the request handler is asked** (measured on a Mac mini whose guest reported
  only `audiooutput`), so no prompt can appear.

## §12 `<webview>` guests: navigation, certificates, dialogs and PDFs

- **A remote page's `file://` link is refused inside the guest's renderer**: no
  `will-navigate`, no permission request, nothing main sees but a console line. To the
  user the link looks dead.
- **⌘+click and middle-click are not turned into `window.open`**, so the window-open
  handler never hears of them and the page navigates in place. A middle click fires
  only `auxclick`.
- **`alert` / `confirm` / `prompt` become native OS dialogs** that name no origin, sit
  outside the app window, and may not appear in a headless run.
- **`will-prevent-unload` is answered at once.** If main does not `preventDefault`, the
  page's `beforeunload` cancel wins, and a guest with such a handler can block its own
  navigation or close for good.
- **`certificate-error` and `login` (basic auth) exist only on `app`**, not per session:
  code for one partition has to check `contents.session` itself. Unhandled, Electron
  refuses the certificate and cancels the auth.
- **Chromium caches `setCertificateVerifyProc` answers per host**, so a proc installed
  again after the user clicks past a warning is never asked; the retry fails on the
  cached refusal.
- **`session.clearData()` leaves the HTTP auth cache and open connections.** A pooled
  TLS socket has already done its handshake, so a cleared certificate exception is not
  asked about again on it until `closeAllConnections()`.
- **Electron's built-in `file://` loader answers `ERR_FILE_NOT_FOUND` for a folder**;
  Chromium's folder-listing page is not wired in.
  `ses.fetch(request, { bypassCustomProtocolHandlers: true })` reaches that built-in
  loader without calling a custom `file` handler again.
- **Chromium fetches `/favicon.ico` after every navigation**, so a server's request
  count sees one extra hit per page load.
- **The built-in PDF viewer (PDFium) keeps its page position to itself**: `scrollX` /
  `scrollY` cannot read it, so a reload loses it for good, and `findInPage` cannot
  search it — only the plugin's own find (⌘F reaching the guest) can.

## §13 `<webview>` guests: downloads and sound

- **Chromium MIME-sniffs even a `Content-Disposition: attachment` response**, and until
  the sniff settles the transfer belongs to the frame that asked, not the session. For
  a body that trickles in, the sniff settles only at its last byte, so closing that tab
  cancels the download. `x-content-type-options: nosniff` settles it at the headers.
- **`DownloadItem.getFilename()` flattens a traversal name**: `../../evil.sh` arrives
  as `_.._evil.sh`, which hides the traversal from a basename check.
- **Electron allows autoplay by default**, so a guest can play sound on load. A muted
  stream still counts as playing; only
  `autoplayPolicy: 'document-user-activation-required'` keeps a guest truly silent.
- **`isCurrentlyAudible()` gives false positives under load** (measured with 4 workers:
  audible for seconds on a guest whose `play()` was refused and which stayed muted).
  `isAudioMuted()` is the dependable signal.

## §14 `<webview>` guests: passing as Chrome

- **Electron sends no `Sec-CH-UA` Client Hints headers at all** (verified on live
  HTTPS), while real Chrome always sends the three low-entropy ones on secure pages. A
  Chrome user agent with no Client Hints gives the embedded browser away.
- **Google's sign-in gate reads these on the server** — `userAgentData` / Client Hints
  brands, `window.chrome.loadTimes` / `csi`, and `navigator.webdriver`. A guest whose UA
  says Chrome while its brands list only Chromium is marked as embedded (from manual
  finds; best effort).
- **`navigator.userAgentData` may return a fresh object on each access**, so a patch has
  to go on its prototype, not on one instance.

## §15 Chrome extensions in Electron (electron-chrome-extensions)

- **Electron has no "disabled" state for an extension.** Switching one off means
  `removeExtension`, and `loadAllExtensions` brings it back next launch from its folder.
- **An unpacked extension's id comes from its folder path**: same path, same id; two
  copies in two folders are two extensions.
- **`extension-loaded` fires while `loadExtension` is still awaited**, before its
  promise resolves.
- **The library's gaps**: no `chrome.commands`, `declarativeNetRequest` (MV3 ad blockers
  are weakened), `sidePanel` or new-tab takeover. `storage.sync` falls back to local in
  service-worker and extension pages and fails softly (`lastError`) in content scripts,
  while `storage.local` works — measured; the Electron binding layer cannot shim it.
- **The action popup is placed only after the extension page reports a preferred size**
  — several frames after the window exists, and never for a page that reports none.
  Its gap under the address bar is 5 px. The library refuses to run an action when no
  current tab is selected.
- **The popup's `blur` fires only when another app takes focus**, not on a click
  elsewhere in the host window. If the popup's document is destroyed between keydown
  and keyup, the rest of the keystroke is lost.
- **Registration order**: the library registers its preload scripts in its constructor,
  and patches `chrome` from them. A preload registered later with
  `session.registerPreloadScript` runs after them, so it can alias `browser` onto the
  patched `chrome`; it must be registered before an extension's service worker starts.
  In the service-worker realm such a preload has no `location` at all.
- **Chromium's native `browser` global is a different object from `chrome`**, and the
  library patches only `chrome`. An extension that mixes the two (1Password does,
  observed) fails on its first `browser.windows.*` call. In real Chrome both names
  point to the same bindings.
- **`handleCRXProtocol` is per session**, not per library instance: the host window on
  the default session needs its own call to serve `crx://extension-icon/`. The library
  registers the privileged `crx` scheme itself only if it is imported before the app is
  ready; otherwise the app must register `crx` (bypassCSP) itself, or action icons do
  not load.
- **A content script with `run_at: document_start` can run before
  `document.documentElement` exists.**

## §16 CDP through `webContents.debugger`

- **Electron's own `Target.createTarget` returns nothing**, so a CDP client cannot open
  a page through it; a relay has to answer it itself.
- **The guest's own (root) session id arrives as an empty string, not undefined.**
  Passed on, it addresses page events to the browser session, and Playwright then
  reports "Frame has been detached" on the first `newPage` (measured).
- **Flat mode**: a guest announces its sub-targets (a cross-origin iframe, a worker) on
  the ROOT session, with the child's `sessionId` inside `params`.
- **Chrome's rules**: `Target.targetCreated` belongs to discovery and
  `Target.attachedToTarget` to auto-attach — a client that asked for one is not sent the
  other. `Target.setAutoAttach` never fails just because one target could not attach.
- **Input follows the window's focus, not the CDP target.** On a guest that is not the
  host's focused element, `Input.insertText` answers ok and changes nothing, and
  `Input.dispatchKeyEvent` lands wherever the user's focus is (measured: an agent's form
  fill went into the TUI the user was typing in). A real `Input.dispatchMouseEvent`
  mousedown makes the guest the window's focused frame and takes the host's focus
  (measured). An in-page `focus()` moves nothing in the host.
- **A second `about:blank` load is a second navigation**: a CDP client that grabbed the
  page between the two is left holding a detached frame (measured with a real client).
- **`webContents.debugger` and the DevTools window can hold one guest at the same time**,
  whichever comes first, and neither is thrown off (measured on Electron 43 /
  Chromium 150).

## §17 Playwright as a CDP client

- **What `connectOverCDP` expects** (measured against playwright-core 1.62 where
  marked): right after the handshake it sends `Target.getTargetInfo` with no `targetId`,
  asking for the browser's own target, and drops the connection on an error (measured).
  Every attached target must have type `page` (it refuses a `<webview>` type) and a
  non-empty `browserContextId`. A page announced twice is rejected ("Duplicate
  target"); a page it is told has detached is dropped at once (measured: one page seen
  where two had just opened). A failed `Target.setAutoAttach` reads as "there is no
  browser" and rejects the whole connection. The handshake has 30 s in all, and the
  default command timeout is also 30 s.
- **Target id must equal main-frame id.** Playwright stores a page's session by target
  id and looks it up by main-frame id (crPage.ts); in Chrome both are the same 32-hex
  string, so made-up target ids break every page action with "Frame has been detached"
  (measured).
- **A socket the server closes before Playwright's first command hangs
  `connectOverCDP` for its whole timeout** (measured: 30 s on BB-49, 6 s on BB-25).
- **playwright-mcp reads `PLAYWRIGHT_MCP_CDP_ENDPOINT`** with no other setup, and an
  injected endpoint wins over the tool's own `--isolated` flag.
- **playwright-mcp sends a notification between its replies**: 0.0.82 (Playwright
  1.64 alpha) writes `notifications/tools/list_changed`, a message with no `id`,
  after the `initialize` reply and before the first tool result (measured
  2026-09-23, reading its stdout). A client that counts lines as replies stops one
  reply early.
- **When playwright-mcp or playwright-cli starts a browser of its own, it is the
  machine's Google Chrome**, not the ms-playwright bundle; it can be told apart by
  Playwright's launch flag `--disable-field-trial-config`, not by its path.
- **A `connectOverCDP` rejection left unhandled for even one tick takes down the
  Playwright driver session**, so a call expected to be refused needs its rejection
  handler attached as soon as it is made.
- **`connectOverCDP` attaches to every target it is told about, which loads it**; only
  a bare WebSocket CDP client can see a tab as listed but not loaded.
- **`Browser.version()` and `contexts()` are local state** and still answer on a dead
  socket; only a real round trip (such as `page.evaluate`) shows the client is alive.
- **playwright-cli runs one background daemon per (workspace, session name), machine
  wide, and the daemon keeps the env of the process that ran `open`** (measured
  2026-09-24, @playwright/cli 0.1.18 on playwright-core 1.63: session B's `goto` with no
  `open` navigated session A's page inside A's Koloft tab). The session name is the `-s`
  flag, else `PLAYWRIGHT_CLI_SESSION`, else `default`; the workspace is the nearest
  directory holding a `.playwright` folder, else the playwright-core install root, so
  every directory without that marker shares one bucket (read in
  `lib/tools/cli-client/registry.js` and `session.js`). Each Koloft tab therefore
  exports its own `PLAYWRIGHT_CLI_SESSION`. A browser the cli starts itself is headless
  unless `--headed` (read in `resolveCLIConfigForCLI`); playwright-mcp's default is headed.

## §18 Playwright and Electron in the e2e suite

- **A Playwright `Page` never recovers from a renderer crash**: every later call, even
  `reload()`, rejects with "Page crashed", while the Electron side is fine. A
  `webContents.executeJavaScript` made before the reloaded document commits is queued
  on the dead renderer and never settles; wait for `domcontentloaded` first.
- **`electronApp.windows()` includes webview guests and leaves out hidden windows**;
  count with `BrowserWindow.getAllWindows()`.
- **`fill()` and `pressSequentially()` silently do nothing on a `<webview>` guest** until
  a real click has landed inside it (upstream #9729, closed wontfix).
- **A dynamic `import()` of a `file://` chunk shows up as a `request` event.**
- **xterm's `.xterm-screen` covers the row spans**, so `locator.click()` fails its
  actionability check there; the link provider needs a hover then a click, and the DOM
  renderer keeps rewriting spans, so one found by one call may be detached by the next.
- **Electron's window drag area and Chromium's native drag start sit below Playwright's
  synthetic events**, so a test cannot click through them; it can only check the DOM
  shape (`app-region`, element order, a cancelled mousedown).
- **The `list` reporter (the suite's only one) drops attachments** (seen: the first
  diagnostic sent only as an attachment left nothing behind); a diagnostic has to be
  written to a file under `testInfo.outputPath`, which stays on disk.
- **A `click()` in a `<webview>` guest that opens a blocking JS dialog (`alert`,
  `confirm`, `prompt`) does not settle until the dialog is answered**: the dialog blocks
  the guest's input ack that the click waits for. Awaiting the click first deadlocks the
  test, so start it, answer the modal, then await it.

## §19 The `ws` library (8.x)

- **Messages that arrive before any `message` listener is attached are dropped.** A CDP
  client sends `Browser.getVersion` the moment the socket opens (measured: the handshake
  never completed, with an empty transcript).
- **`WebSocketServer.close()` does not end sockets already upgraded**; each must be
  closed by hand.

## §20 GPU and WebGL in Chromium

- **About 16 live WebGL contexts per renderer process**, shared by every tab in it.
  Past that Chromium kills the oldest ("Too many active WebGL contexts. The oldest
  context will be lost."), which scrambles that terminal's glyphs.
- **GPU memory can be lost with no event.** Wake from sleep, screen unlock, and adding,
  removing or changing displays (these come in bursts) can wipe texture memory; a
  minimized or fully covered window can lose its WebGL drawing buffers. No
  `webglcontextlost` fires and the xterm atlas page versions still match, so rows stay
  stale or blank until the atlas is cleared and repainted.
- **A `display:none` WebGL canvas loses its drawing buffer.** `term.refresh()` redraws
  into the stale buffer and never re-creates it; only a resize does, and xterm's
  `handleResize` takes that path even when cols and rows are unchanged (observed: only a
  manual window resize brought a blank re-shown tab back).
- **Moving the window between monitors with different devicePixelRatio can corrupt the
  WebGL glyph atlas**; clearing the atlas on each DPR change fixes it (observed).

## §21 xterm.js

- **Write buffer**: xterm takes in about 5–35 MB/s and silently throws away written
  data past a hard cap of about 50 MB. Its flow-control guide says to keep about
  500 KB or less pending.
- **Resize inside synchronized output shows black.** xterm holds back every row refresh
  while DEC mode 2026 is on, until `?2026l` or a 1000 ms safety timeout, but
  `RenderService.handleResize` ignores the mode: under WebGL it resets `canvas.width`,
  wiping the buffer at once, and the repaint is held back — up to about 1 s of black
  terminal. Read from the xterm 6.0 source; introduced in 6.0 and still unfixed in
  6.1.0-beta.302; reproduced by `sync-output-resize.spec.ts`.
- **xterm pauses while hidden.** Its RenderService pauses through an
  IntersectionObserver (`_isPaused`), and `refreshRows` then only marks
  `_needsFullRefresh`; a resize is kept in `_pausedResizeTask` and flushed on un-pause.
  On re-show, the un-pause arrives as a task after that frame's rAF step, so a repaint
  needs a second rAF; another IntersectionObserver's callback is delivered in the same
  task. Showing a hidden xterm runs its first full render synchronously, before paint —
  0.1–0.8 s for a screen full of CJK at 2560×1440 (measured). The pause, and the fit
  addon doing nothing at 0×0, happen only for `display:none`; a `visibility:hidden`
  terminal keeps painting and refitting.
- **FitAddon on a `display:none` element** reads `getComputedStyle(el).height` as
  `100%`, works out a tiny size (about 6 rows × 10 cols) and shrinks xterm and the pty;
  for an alt-screen TUI the rows that grow back stay blank.
- **xterm answers some queries by itself** (focus reports, mouse reports, DA/CPR) on the
  same `onData` path as real keys, so pty input alone cannot show that a person typed.
- **xterm's hidden textarea keeps the Tab key**: focus that reaches a terminal does not
  move on, so a forward Tab walk has to start past it.
- **XTVERSION**: the query is `CSI > 0 q` (or `CSI > q`) and a reply is
  `DCS > | <name> ST` (xterm docs); xterm ≥ 6.1 answers `xterm.js(<version>)`. xterm
  always answers DA1 (`CSI 0 c`).
- **OSC 8 links**: xterm's own OSC 8 provider wins over the web-links addon, and with no
  `linkHandler` it falls back to a native `confirm()` plus `window.open`.
- **Under the WebGL renderer the terminal has no text nodes**; `innerText` is empty, so
  read the buffer through the xterm instance.
- **xterm's CSS hard-codes the IME composition box** (`.xterm .composition-view`) to
  `background:#000`, a black box over a themed terminal while typing through an IME.

## §22 xterm.js input method (IME) defects

From upstream issues and PRs, as the old notes cited them:

1. The preedit is anchored to a stale cursor, because `updateCompositionElements`
   returns early while not composing (xtermjs/xterm.js#5454, fixed upstream by #5759).
2. A long preedit runs past the right edge because the overlay is `white-space:nowrap`;
   upstream #5747 clamps it but with `direction:rtl`, which draws CJK preedit backwards
   (#5760).
3. A leading space leaks from `_handleAnyTextareaChanges`' first-match `String.replace`
   diff while committed text is still in the helper textarea (#6012, still open
   upstream). Patching at the renderer level cannot fix it alone.
4. CompositionHelper sends composition text through `onData` on two paths (the
   keyCode-229 path and `_finalizeComposition`'s `setTimeout`); they fall out of step
   when pinyin is committed by switching input method, and the text is sent twice.
5. xterm clears its helper textarea only on Enter or Ctrl+C.
6. xterm sends halfwidth ASCII punctuation on keydown and `preventDefault`s the IME's
   fullwidth substitution. Its own `compositionstart` / `compositionend` listeners are
   registered before any the app adds.
7. Some IMEs (WeChat among them) end a composition with empty `compositionend` data
   and hand the text over through a trailing `insertText`, so the committed text stays
   in the helper textarea and feeds defect 3 on the next keystroke. Only a clear put off
   by one `setTimeout(0)` drains it without losing the text: xterm's
   `_finalizeComposition` reads the textarea in its own `setTimeout(0)`, queued first
   because its listener was added first (defect 6), so it has sent the text by then.

Version state needs a recheck: one old note says #5759 and #5747 are in the shipped
6.1.0-beta; another says #5759 was in no stable release (6.0.0 included).

## §23 xterm.js WebGL glyph atlas

- **The atlas is shared** by every terminal with the same font, theme and DPR
  (`CharAtlasCache`), so healing one terminal after a page merge or a clear leaves the
  others drawing stale coordinates into a changed atlas (upstream #5883/#6014).
- **It has at most 16 pages, and the page count only goes up.** `clearTexture()` empties
  pages but never removes entries from `_pages`, and a merge fires only on
  `_pages.length >= maxAtlasPages`, so clearing early cannot stop merges. Every char ×
  colour × bold is its own key, so heavy CJK output fills it fast: about 24k keys
  (4k CJK code points × 6 colours) force repeated merges, which reliably garbled the
  screen on addon 0.19.0 and older (read from the addon source; upstream #6014/#6055).
- **`onRemoveTextureAtlasCanvas`** has been public typed API since addon 0.19.0. It
  fires only from a page merge, once per deleted page, to every addon sharing the atlas.
  After a merge the renderer heals on the NEXT frame, so output that stops on the merge
  frame leaves the screen garbled until something asks for a refresh.
- **A terminal joining or leaving churns the shared atlas**: pages are added when an
  xterm mounts and dropped or merged when one is disposed, and a merge that lands on a
  frame no remaining terminal redraws leaves them garbled (seen: closing a Workbench
  tab scrambled the Claude TUI). A WebGL terminal taken out of the layout entirely,
  with no xterm mounting or disposing (seen: the Claude TUI behind a full-width
  Workbench), came back blank until the atlas was cleared and repainted (§20).

## §24 DOM, CSS and form controls in Chromium

- **A `<textarea>` turns every CRLF, and every lone CR, into LF** on the way in
  (measured), so its text for a CRLF file never equals the file's bytes.
- **Setting `scrollTop` in code fires `scroll` later**, not during the assignment; a
  flag cleared on the next line is already false when the listener runs.
- **`overflow-x: auto` alone turns `overflow-y` from visible into auto** (CSS Overflow
  Level 3), so a box can report `overflow-y: auto` without scrolling; only
  `scrollHeight > clientHeight` shows a real vertical scroller.
- **A `transform` on an ancestor traps `position: fixed`**: the box is laid out against
  that ancestor, not the viewport, and stuck in its stacking layer (a manual-test find).
- **With `border-collapse`, table borders do not follow a `position: sticky` cell**; an
  inset `box-shadow` does.
- **`direction: rtl` with `text-overflow: ellipsis` puts the ellipsis at the front**, so
  the end of a name survives; a leading U+200E (LRM) keeps a name that starts with a
  neutral character (`.gitignore`) from being reordered.
- **A native `<input type=time>` on a dark surface needs `color-scheme: dark`**, or
  Chromium paints its focused segment and picker icon for the light scheme and the
  segment cannot be read (seen in a manual round).
- **`-webkit-app-region: drag` does not follow a scrolled container** (electron#40610):
  a stale drag rectangle stays, and a tab under it loses clicks to window drags.
- **`getComputedStyle().borderColor` is `''` when the four sides differ**, and
  `getPropertyValue('--token')` returns the token's raw text; assigning it to
  `border-top-color` on a probe element normalises it.
- **SVG `<image>` and `<feImage>` fetch through `href` / `xlink:href`, not `src`**, so
  a sanitizer hook that checks only `src` never sees them, and
  `<svg><image href="https://…"/></svg>` works as a network beacon.
- **CSS `image-set('https://…' 1x)` in a `style` attribute fetches from the network
  without ever spelling `url(`.**

## §25 React and zustand

- **React 19 sets `innerHTML` again whenever the `dangerouslySetInnerHTML` wrapper is a
  new object**, even with the same string. The DOM is rebuilt, scroll resets, and a
  MutationObserver on it fires again (observed as BUG-P1-01: a find-bar observer and
  the rebuild fed each other until real key events froze the renderer).
- **React runs a child's effects before its parent's** in the same commit, so a rAF the
  parent queues runs after one the child queued.
- **Two siblings under the same key leave orphan DOM.** The reconciler keeps only the
  LAST one in its key map and never deletes the first; once the list changes shape
  ahead of it, the first one's nodes stay in the document for good (seen live: one
  session's rows stacked twice).
- **zustand's `set()` notifies every subscriber even when nothing changed**, because it
  merges into a new state object (seen: a queued hint card appeared one tick early).

## §26 Markdown, diagrams and highlighting libraries

- **mermaid**: the default `maxTextSize` is 50000, and a longer source is silently
  swapped for a "Maximum text size exceeded" graph instead of throwing (read from
  `mermaid.core.mjs` `render()`). The stock `secure` list covers `securityLevel`,
  `startOnLoad`, `maxTextSize`, `suppressErrorRendering` and `maxEdges` but not
  `htmlLabels` or `themeCSS`, so a document's own `%%{init}%%` can set those two. With
  `htmlLabels` on, labels go in `<foreignObject>`, which DOMPurify strips; in mermaid 11
  the root key wins, but the flowchart renderer still reads `flowchart.htmlLabels`
  directly in two places. A document's `%%{init}%%` is applied to the process-wide
  config at the start of `render()`, so two renders at once can leak settings. Labels
  are measured with `getBBox`, which needs a laid-out node; with no container argument
  mermaid adds its own scratch `<div>` to `<body>`. `fontFamily` lands in SVG
  presentation attributes while widths are measured, and a CSS `var()` there is not
  reliably honoured.
- **KaTeX**: when it refuses a formula, the `.katex-error` element's text is a
  ParseError message with combining marks stitched through the source; the untouched
  source is in its `title` attribute. Its default `maxSize` is Infinity, so an untrusted
  formula like `\rule{999999em}{999999em}` can blow up the layout.
- **DOMPurify**: `SAFE_FOR_XML` (on by default) deletes any attribute whose DECODED
  value contains `-->` or `]>`; HTML-escaping does not help (seen: every mermaid
  flowchart lost its source).
- **shiki**: importing the main `shiki` entry registers every bundled language as a
  lazy chunk, so vite emits about 280 grammar files (about 8 MB) plus the oniguruma
  wasm, though none load; `shiki/core` plus single `@shikijs/langs/*` keeps only those.
  The JavaScript regex engine supports every built-in language since shiki 3.9.1, with
  no wasm.

## §27 Node: child processes and network

- **`execFile`'s `timeout` signals only the direct child.** A grandchild (git's ssh or
  https helper, an `ext::` helper) survives and can hold the terminal forever; kill the
  whole process group (spawn detached, then `kill -pid`). Pinned by a unit test with a
  never-answering `ext::` remote.
- **`execFile` gives the child an open stdin pipe that is never closed**, so a child that
  reads stdin blocks until the timeout.
- **`err.code` in `execFile`'s callback**: a number for the child's exit code; a string
  when Node could not run it (missing binary, output past `maxBuffer`); absent when it
  was killed.
- **The default `maxBuffer` is 1 MB**; past it the call throws
  `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` (measured: an ignored-files listing of a
  20 000-file node_modules was 1 240 022 bytes).
- **`execFileSync` with `cwd: undefined` quietly runs in `process.cwd()`** (an incident:
  a fixture helper ran `git init` and a commit in the developer's real checkout).
- **`https.get` throws synchronously on a non-https URL**; during a redirect that throw
  is inside the parent response callback and escapes to `uncaughtException`.
- **A failed `fetch`'s error `cause` chain can turn the request options into text,
  Authorization header included.**

## §28 Node: file watching

- **`fs.watchFile` is a stat poll that follows the path, not the inode.** It keeps
  seeing a file an editor replaces by rename, and fires when the file or its folder
  goes away; `fs.watch` does not follow a rename. Two changes inside one poll interval
  arrive as one event, and a change undone within it is not seen.
- **`fs.unwatchFile(path)` with no listener removes every listener on that path**,
  other modules' included.
- **`fs.watch` can drop or merge events** — for a file that is rewritten again and
  again, a whole write can go unreported, and a dropped LAST event never comes back
  without a poll.
- **`fs.watch` on a folder that does not exist yet throws**; a watch attached before the
  folder appears never fires.
- **A recursive folder watcher cannot be trusted to report the removal of the watched
  folder itself.**

## §29 node-pty and ptys

- **A process killed by a signal is reported with `exitCode` 0** and the signal in
  `signal` (read from node-pty's `pty.cc`, which keeps WIFEXITED and WIFSIGNALED apart).
- **node-pty tears down its socket about 200 ms after exit**, so a pty paused at exit
  can lose its last output.
- **`.process` is typed as string but can be `undefined`** on macOS: it is a native read
  of the tty's foreground process, and returns `undefined` between two commands (the
  darwin branch has no fallback); it does not throw. Where it falls back, it gives the
  spawn file path (`/bin/zsh`), not a command name. Fast pipelines hit the gap within
  seconds (read from `unixTerminal`; a shipped crash in v0.16.2 raised Electron's error
  dialog every 1500 ms).
- **Resizing a pty to the size it already has sends no SIGWINCH.**

## §30 git

- **Prompts**: `GIT_TERMINAL_PROMPT=0` alone does not stop git asking; a configured
  askpass (`GIT_ASKPASS`, `core.askpass`, `SSH_ASKPASS`) still gets through, and
  `GIT_ASKPASS` in the env beats the repo's `core.askpass` (pinned by a unit test
  against a local server answering 401).
- **`GIT_OPTIONAL_LOCKS=0`** makes read-only commands like `status` skip `index.lock`,
  so they cannot collide (rc=128) with an agent's `git add` in the same checkout.
- **A failing `git pull` puts the cause last on stderr** (`fatal:` / `error:`), after the
  `From <url>` progress line and sometimes before `hint:` lines.
- **`git rev-parse --show-toplevel` prints the realpath**, so a folder reached through a
  symlink (`/tmp` → `/private/tmp`) gets a toplevel that does not start with the path
  asked about.
- **`git check-ignore`**: `-z` is only valid with `--stdin` (with pathspecs git exits
  128, which once silently turned the filter off on every repo). It exits 1 with empty
  output when nothing is ignored — a normal answer — and 128 outside a repo.
- **`git ls-files`**: `--others` (and `--ignored`) prints a nested repository as one
  `dir/` entry. Run with `-C <dir>` it lists only files under that folder, relative to
  it, while `git diff --name-status` prints toplevel-relative paths for the whole repo
  (measured).
- **`git diff --name-status <base>` shows an unmerged file as plain `M`**; `U` appears
  only in a bare index-vs-worktree diff, `--cached` and porcelain (`UU`), and
  `git ls-files -u` lists unmerged paths directly (measured).
- **`git diff --no-index` exits 1 whenever the sides differ**, so its diff arrives on a
  rejected `execFile`'s stdout. A file caught mid-rewrite by `cat >` can be read at zero
  bytes (measured: an 85-character diff, a header with no hunks), or the read fails.
- **In a linked worktree `.git` is a FILE** holding
  `gitdir: <repo>/.git/worktrees/<name>` (a submodule: `.git/modules/<name>`); the
  gitdir can be relative, and the common repo root is three levels above a worktree's
  gitdir.
- **A worktree made inside the repo (under `.claude/worktrees/`) is not ignored by
  itself**; without a `.gitignore` line the parent shows an untracked `.claude/`.
  `--exclude-standard` honours an uncommitted `.gitignore`.
- **`git worktree add <path>` refuses a path that already exists.**
- **`.git/FETCH_HEAD` is rewritten on every fetch** and a fresh clone has none, so its
  existence and mtime show whether a fetch ran.
- **The `ext::` transport** is refused unless `protocol.ext.allow` permits it (the repo's
  own config is enough), and git splits its command on spaces.

## §31 ripgrep and git grep

- **Output with NUL separators**: `rg --null` prints `<path>\0<line>:<text>`, while
  `git grep -z -n` prints `<path>\0<line>\0<text>`.
- **With no search path and a stdin that is not a tty, rg reads stdin** — under
  `execFile` (an open pipe) it blocks forever. rg exits 1 for no matches, and exit 2 can
  still come with printed matches when some file failed to read.

## §32 GitHub

- **Anonymous API calls are limited to 60 per hour.**
- **The edge can answer one request with a 5xx and the next with 200** (observed: 504 on
  the releases list, 2026-09); one retry after a short pause fixes it.
- **Release asset URLs answer with a 302** to a signed S3 host.
- **A private repo answers 404 to a signed-out browser**, not a login form, and
  `https://github.com/login?return_to=<path>` brings the same tab to the target once
  login finishes (checked by hand, signed out, on a private repo).
- **A signed-in browser holds a `logged_in=yes` cookie**; `user_session` is the session
  cookie itself.

## §33 ssh

- **ssh does not create the ControlPath folder**; if it is missing, every command fails
  at once with "No such file or directory".
- **A command riding an existing ControlMaster has no connect phase**, so
  `ConnectTimeout` never applies; only a local timeout can stop it.
- **ssh honours the FIRST `-o` given for a key**: `-o BatchMode=yes` added after a
  user's `GIT_SSH_COMMAND` loses to their own BatchMode but beats the default.
- **`ssh host cmd` runs the command in a non-login shell — the user's own shell
  program**, which can be fish. `~/.local/bin`, `~/.koloft/node/bin` and, on a macOS
  host, `/opt/homebrew/bin` are not on PATH there, and `{ }`, `$$` and `export` are not
  safe syntax.
- **ssh exits 255 when the host cannot be reached**, and rsync over ssh does the same.

## §34 rsync

- **macOS ships openrsync, not GNU rsync.** Its protocol has 1-second time resolution,
  so a same-size rewrite within one second is skipped unless `-I` is passed.
- **`--inplace` writes through the existing file**, so an unchanged round leaves the
  inode and times alone. Without it every round re-creates changed files (new inode each
  pull), and even with it an unchanged file may be touched again, so a watcher can see
  it again.
- **Mirrored files keep the source machine's mtime**, not the time they arrived.

## §35 tmux

- **`tmux -f <conf>` counts only for the server that command starts**; a machine with a
  tmux session already running keeps the old config until its last session ends.
- **`new-session -A -s <name> <cmd>` attaches to an existing session and never runs
  `<cmd>`**; `attach -t <name>` for a session that is gone exits 1.
- **With no `default-shell`, tmux runs the new-session command through `$SHELL`**, the
  login shell — for a fish user, sh syntax is a syntax error.
- **With `mouse off`, tmux 3.6b passes the pane's mouse-mode requests (1000/1002/1006)
  to the outer terminal untouched** (measured locally in a python pty).
- **tmux sets `TMUX` and `TMUX_PANE`** for a command inside a session.
- **tmux's default server socket is `tmux-<uid>/default` under `$TMUX_TMPDIR` or
  `/tmp`, not under `$HOME`** (tmux(1)), so a fake `$HOME` does not isolate it: a real
  tmux run by any test talks to the one server this user already has, shared by every
  run and holding other homes' sessions.

## §36 ccstatusline

- **Git-review cache**: pull request state lives in
  `~/.cache/ccstatusline/git-review/*.json`, stale when `now - mtime > 30 000 ms`; a
  `*.json.lock` younger than 30 s stops a refresh. After a tool result Claude Code
  re-renders the statusline within about 300 ms, and that render starts ccstatusline's
  own background `gh` fetch.
- **Parsing the 3.1 MB bundle is most of each render's cost**; `NODE_COMPILE_CACHE`
  removes it.
- **Its stdout is a pipe**, so it sizes flex layouts only from `CCSTATUSLINE_WIDTH`.
- **It never exits while its stdin stays open** (upstream #485), and Claude Code
  sometimes keeps it open.
