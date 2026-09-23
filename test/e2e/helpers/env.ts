import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * A throwaway, fully isolated $HOME for one E2E app instance. os.homedir() follows
 * $HOME on POSIX, so pointing HOME here makes EVERYTHING hermetic in one move:
 *  - the tracker tails $HOME/.claude/projects (never the developer's real sessions),
 *  - the shim / hooks / settings / layout live under $HOME/Library/Application Support/koloft-dev,
 *  - login shells source an empty profile, so PATH isn't polluted by the user's rc.
 * Everything is realpath'd so the symlinked /tmp and /var on macOS can't cause a
 * cwd-vs-jsonl-dir mismatch.
 */
export interface E2EEnv {
  home: string
  /** userData dir for the unpackaged (dev) build — app.setName('koloft-dev') */
  userData: string
  /** dir the Koloft shim is written into ($userData/shim) — known ahead of launch */
  shimDir: string
  /** dir holding the fake `claude` + fake `open` + fake `security` executables */
  fakeBin: string
  /** the {service:{account:secret}} JSON both main's seam and the fake `security`
   *  serve tokens from (KOLOFT_KEYCHAIN_FILE) */
  keychainFile: string
  /** file the fake `open` appends its argv to — passthroughs land here, never in the
   *  real /usr/bin/open (which would launch actual apps during a test run) */
  openCalls: string
  /** JSONL the fake `claude` appends one {pid, argv, cwd, sessionId, ts} record to per
   *  launch. A process-boundary observation point: WAS claude launched (again), with
   *  WHICH flags, and is the previous process still alive — all from outside the app. */
  claudeCalls: string
  /** file a `claudeCommand` wrapper written by writeClaudeWrapper() appends its argv to */
  wrapperCalls: string
  /** stand-in for claude's hardcoded `/tmp/claude-<uid>` scratchpad base (KOLOFT_SCRATCHPAD_BASE).
   *  Both main (scratchpadDirFor) and the fake `claude` read the seam, so a session's
   *  scratchpad lands at `<scratchpadBase>/<projectSlug>/<sessionId>/scratchpad`. */
  scratchpadBase: string
  /** write a ms count here to make the fake `claude` start but delay its SessionStart
   *  hook + transcript by that long — a claude tab with no session bound yet. Delete
   *  it to go back to binding immediately. */
  claudeDelayFile: string
  /** touch this to make the fake `claude` bind (SessionStart) but never report a
   *  run-state — no prompt/stop hooks fire (T-LIFE-10's 'claude'-state row) */
  claudeNoStatusFile: string
  /** write an exit code here to make the fake `claude` print one error line and exit
   *  immediately, firing no hook at all (T-LIFE-03's early-exit launch failure) */
  claudeExitFile: string
  /** touch this to make a FRESH fake `claude` bind (SessionStart) but write no
   *  transcript — real Claude Code creates the jsonl lazily, at the first user
   *  message, so a session that was never typed into has none. The
   *  first typed line writes it. `--resume` launches ignore the file. */
  claudeLazyFile: string
  /** the only directory a test run may ever download into (KOLOFT_DOWNLOAD_DIR) — the
   *  developer's real ~/Downloads must stay untouched */
  downloadDir: string
  /** the file-dialog seam (KOLOFT_FILE_DIALOG_FILE): the queue `preview.openFileDialog`
   *  answers from, one absolute path per line, consumed head-first. Absent/exhausted =
   *  the user cancelled. Drive it through helpers/workbench.ts (`answerFileDialog`),
   *  never by writing here directly. */
  fileDialogFile: string
  /** every `git` the APP spawned, appended by the recording wrapper `installGitSpawnLog`
   *  puts on PATH (helpers/workbench.ts). Absent until a spec installs it — the wrapper
   *  sits in front of every git the app runs, so most specs must not pay for it. */
  gitCalls: string
  /** file the app appends one line to whenever something would leave for the system
   *  browser / OS handler (KOLOFT_EXTERNAL_OPENS_FILE). The single choke point every
   *  escape path funnels through, so "nothing was forced out of Koloft" is decidable as
   *  "this file does not exist". */
  externalOpens: string
  /** created workspace dirs (realpath'd), keyed by name */
  workspaces: Record<string, string>
  /** extra Electron/Chromium switches for this launch, appended by launchApp. Push
   *  BEFORE launching (e.g. a `--host-resolver-rules=…` alias map for the self-signed
   *  https fixture); argv is fixed at spawn time. */
  extraArgs: string[]
  /** env to hand Playwright's _electron.launch */
  launchEnv: NodeJS.ProcessEnv
  cleanup(): void
}

const FAKE_CLAUDE_SRC = path.join(__dirname, '..', 'fixtures', 'fake-claude.js')

function makeWorkspace(home: string, name: string, files: Record<string, string>): string {
  const dir = path.join(home, name)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return fs.realpathSync(dir)
}

export function setupE2EEnv(): E2EEnv {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-e2e-home-')))

  // On macOS app.getPath('userData') derives from the *real* user Library, NOT $HOME,
  // so isolating userData needs the explicit --user-data-dir switch (see launchApp).
  // This is that dir; the shim/hooks/settings/layout all live under it.
  const userData = path.join(home, 'userData')
  fs.mkdirSync(userData, { recursive: true })
  const shimDir = path.join(userData, 'shim')

  const fakeBin = path.join(home, 'fakebin')
  fs.mkdirSync(fakeBin, { recursive: true })
  const fakeClaude = path.join(fakeBin, 'claude')
  fs.copyFileSync(FAKE_CLAUDE_SRC, fakeClaude)
  fs.chmodSync(fakeClaude, 0o755)

  // a recording fake `open`, found by the open shim's passthrough scan (it sits on
  // PATH after the shim dir): a passthrough during a test must never reach the real
  // /usr/bin/open and launch an actual app on the machine running the suite.
  const openCalls = path.join(home, 'open-calls.txt')
  // the "leave Koloft" choke point (TEST-2). Nothing creates it up front: its very
  // ABSENCE is the P1 acceptance for an http flow.
  const externalOpens = path.join(home, 'external-opens.txt')
  const fakeOpen = path.join(fakeBin, 'open')
  fs.writeFileSync(
    fakeOpen,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${openCalls}"\nexit 0\n`,
    {
      mode: 0o755
    }
  )
  fs.chmodSync(fakeOpen, 0o755)

  // fake `security` (multi-account): serves tokens from the KOLOFT_KEYCHAIN_FILE JSON
  // fixture — the same file main's in-process seam reads — so the SHIM's Keychain
  // reads stay hermetic and never touch the developer's real login keychain.
  //
  // It is installed in BOTH fakeBin and shimDir, because those cover two different
  // PATH shapes and only one of them is under the test's control:
  //  - fakeBin wins when a spec types its own `export PATH="shim:fakeBin:…"` line.
  //  - shimDir is what Koloft itself re-pins after the rc files run (setupLine), and it
  //    is the ONLY dir guaranteed ahead of /usr/bin in a pty Koloft spawns on its own
  //    (a restart, a ＋Claude tab): macOS's path_helper hoists /usr/bin above
  //    whatever Koloft handed the pty, so a fakeBin-only copy loses to the REAL
  //    /usr/bin/security there and the shim would read the developer's keychain.
  // Seeded before launch: setupShim() mkdir -p's shimDir without clearing it, and
  // its pruneStale only touches *.json.
  const keychainFile = path.join(home, 'keychain-fixture.json')
  const fakeSecuritySrc =
    `#!/usr/bin/env bash\n` +
    `acct=""; svc=""; prev=""\n` +
    `for a in "$@"; do\n` +
    `  [ "$prev" = "-a" ] && acct="$a"\n` +
    `  [ "$prev" = "-s" ] && svc="$a"\n` +
    `  prev="$a"\n` +
    `done\n` +
    `node -e 'const fs=require("fs");try{const d=JSON.parse(fs.readFileSync(process.env.KOLOFT_KEYCHAIN_FILE,"utf8"));const t=(d[process.argv[1]]||{})[process.argv[2]];if(t){process.stdout.write(t);process.exit(0)}}catch(e){};process.exit(44)' "$svc" "$acct"\n`
  fs.mkdirSync(shimDir, { recursive: true })
  for (const dir of [fakeBin, shimDir]) {
    const f = path.join(dir, 'security')
    fs.writeFileSync(f, fakeSecuritySrc, { mode: 0o755 })
    fs.chmodSync(f, 0o755)
  }

  // the isolated stand-in for claude's `/tmp/claude-<uid>`: created up front so it can be
  // realpath'd like every other path here, and so a spec can read it before any session runs
  fs.mkdirSync(path.join(home, 'scratchpad-base'), { recursive: true })
  const scratchpadBase = fs.realpathSync(path.join(home, 'scratchpad-base'))

  // downloads land here and nowhere else; a test run must never touch ~/Downloads
  fs.mkdirSync(path.join(home, 'downloads'), { recursive: true })
  const downloadDir = fs.realpathSync(path.join(home, 'downloads'))

  // The file-dialog seam (WB-T11/T19/R01/K02). A file rather than an env var for the
  // same reason `fake-claude-next-title` is one: the answer has to change DURING a run
  // (nine ⌘T picks in a row), and argv/env is fixed at spawn. Nothing creates it — an
  // absent queue is the "user cancelled" answer, which is also what keeps a background
  // run safe: with the variable set, main never raises the native dialog at all.
  const fileDialogFile = path.join(home, 'file-dialog-answers')

  const workspaces = {
    a: makeWorkspace(home, 'ws-a', {
      'README.md': '# Workspace A\n\nkoloft-e2e-alpha marker for ws-a.\n',
      'src/app.ts': 'export const answer = 42\n',
      'notes.xyz': 'not previewable\n',
      // a real page for the ".html goes to Browser / View source goes to Preview"
      // routing: a relative stylesheet (proves file:// sub-resources load), an
      // internal #anchor, and one external link (which must land in Browser, never
      // in the Koloft renderer)
      'docs/page.html':
        '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>Koloft fixture page</title>\n' +
        '<link rel="stylesheet" href="page.css">\n</head>\n<body>\n' +
        '<h1 id="top">koloft-e2e-page-html</h1>\n' +
        '<a id="to-anchor" href="#section">jump to section</a>\n' +
        '<a id="to-external" href="http://example.invalid/external">external link</a>\n' +
        '<div style="height:1200px"></div>\n' +
        '<h2 id="section">koloft-e2e-anchor-target</h2>\n' +
        '</body>\n</html>\n',
      'docs/page.css': '#top { color: rgb(1, 2, 3); }\n'
    }),
    b: makeWorkspace(home, 'ws-b', {
      'README.md': '# Workspace B\n\nkoloft-e2e-bravo marker for ws-b.\n'
    })
  }

  // The agent-centric sidebar only aggregates sessions of PINNED workspaces (A1/A2),
  // so the fixture user arrives with both fixture dirs already declared — exactly the
  // state every "type claude, watch the row appear" spec assumes. A spec that needs a
  // different starting layout (fresh install, v1/v2 migration) overwrites this file
  // before its own launchApp — `writeLegacyV2Layout` (helpers/workbench.ts) builds the
  // v2 shape for NFR-06's migration cases.
  //
  // `workbench.defaultOpen: true` is an OPT-IN, not the product's default: since v4
  // the panel ships collapsed (`DEFAULT_PANEL_OPEN`), and this seed is the
  // seam that keeps every spec written against "a session with no entry of its own
  // arrives with the panel expanded" true without each of them expanding it by hand. A
  // case about the shipped default deletes the block before its own launch
  // (workbench-layout.spec.ts WB-L11/WB-P06).
  fs.writeFileSync(
    path.join(userData, 'layout.json'),
    JSON.stringify({
      version: 4,
      workspaces: [{ path: workspaces.a }, { path: workspaces.b }],
      workbench: { defaultOpen: true },
      sessions: {}
    })
  )

  // node's own dir (for the fake claude's shebang) + system bins the shim/hooks need
  // (bash, uuidgen, sed, tr, ps). We deliberately do NOT inherit the developer's full
  // PATH, so a real `claude` there can never shadow the fake one.
  const nodeDir = path.dirname(process.execPath)
  const launchEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    KOLOFT_CLAUDE_CMD: 'claude',
    // multi-account seams: the plaintext keychain fixture (honored because
    // KOLOFT_TEST_BACKGROUND=1) — specs write tokens into it as needed. No
    // KOLOFT_PROBE_BASE_URL by default: probing REFUSES the network in test mode,
    // so a spec that forgets its mock exercises the degradation path.
    KOLOFT_KEYCHAIN_FILE: keychainFile,
    // scratchpad seam: the real base is claude's hardcoded /tmp/claude-<uid>, which a test
    // run must never write into. Inherited by the pty, so the fake `claude` puts its
    // scratch files exactly where main's scratchpadDirFor expects them.
    KOLOFT_SCRATCHPAD_BASE: scratchpadBase,
    // main's shell.openPath fallback goes through LaunchServices, not PATH, so the
    // fake `open` can't catch it — suppress it so no test run ever launches real apps
    KOLOFT_SUPPRESS_OS_OPEN: '1',
    // browser seams. Downloads go to the temp home, never the developer's ~/Downloads;
    // everything that would leave for the OS (openExternal/openPath, ↗) appends one
    // line to the externalOpens file instead, so "nothing was forced out of Koloft" is a
    // file-absence assertion. KOLOFT_BROWSER_GUEST_LIMIT is deliberately NOT set here —
    // the product default is what most specs must see; a cap case calls setGuestLimit().
    KOLOFT_DOWNLOAD_DIR: downloadDir,
    // the relay writes its whole conversation here. A relay failure is invisible
    // from both ends — the client just waits — so the transcript is the only way to see
    // which message never came.
    KOLOFT_CDP_LOG: path.join(home, 'cdp-log.txt'),
    KOLOFT_EXTERNAL_OPENS_FILE: externalOpens,
    // file-dialog seam: SET FOR EVERY LAUNCH, on purpose. A native open-panel in a
    // background run takes focus and then hangs with nothing able to dismiss it, so the
    // suite's answer is "the dialog is never native here" — an empty queue reads as a
    // cancelled pick (WB-K02), and a case that wants a file queues one first.
    KOLOFT_FILE_DIALOG_FILE: fileDialogFile,
    // the suite runs on a live machine: launch as a never-activating accessory app so
    // a test window can NEVER steal macOS focus from what the user is typing
    KOLOFT_TEST_BACKGROUND: '1',
    // skip the WebGL addon (production has no renderer choice) so xterm output is real
    // text nodes Playwright can assert on — webgl draws to an unreadable canvas. The
    // webgl-repair spec deletes this to exercise the real renderer.
    KOLOFT_DOM_RENDERER: '1',
    // force the built renderer (loadFile), never a stray dev server
    ELECTRON_RENDERER_URL: undefined
  }
  delete (launchEnv as Record<string, unknown>).ELECTRON_RENDERER_URL

  return {
    home,
    userData,
    shimDir,
    fakeBin,
    keychainFile,
    openCalls,
    externalOpens,
    downloadDir,
    fileDialogFile,
    gitCalls: path.join(home, 'git-calls.txt'),
    extraArgs: [],
    claudeCalls: path.join(home, 'fake-claude-calls.jsonl'),
    wrapperCalls: path.join(home, 'wrapper-calls.txt'),
    scratchpadBase,
    claudeDelayFile: path.join(home, 'fake-claude-delay'),
    claudeNoStatusFile: path.join(home, 'fake-claude-no-status'),
    claudeExitFile: path.join(home, 'fake-claude-exit'),
    claudeLazyFile: path.join(home, 'fake-claude-lazy'),
    workspaces,
    launchEnv,
    // retries ride out a still-dying shell writing into the dir during teardown
    cleanup: () => fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

/**
 * Patch the seeded settings.json. Must run BEFORE launchApp — main reads settings once
 * at startup, so a later write would not be picked up.
 */
export function seedSettings(env: E2EEnv, patch: Record<string, unknown>): void {
  const file = path.join(env.userData, 'settings.json')
  const current = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    : {}
  fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2))
}

/**
 * Cap the number of simultaneously LIVE browser guests (TEST-8, and's FR-24 /
 * WB-T13 "lower the guest cap" seam — it already existed, so nothing was rebuilt for
 * the merge). A cap case sets 2 or 3 instead of spinning up a dozen renderer processes;
 * must run BEFORE launchApp, since the value travels in the launch env
 * (KOLOFT_BROWSER_GUEST_LIMIT → main's browserGuestLimit(), bridged to the renderer at
 * preload time as `window.api.browserGuestLimit`).
 *
 * FR-24's own cap value is deliberately NOT asserted anywhere (the cases file's Pending
 * list): a case injects a small number and then asserts the FREEZE behavior above it.
 */
export function setGuestLimit(env: E2EEnv, limit: number): void {
  env.launchEnv.KOLOFT_BROWSER_GUEST_LIMIT = String(limit)
}

/**
 * stage the Workbench GitHub button's answer per session directory
 * (`KOLOFT_GITHUB_FIXTURE`, read by `src/main/github.ts`). A directory that is not listed
 * answers "not a GitHub project" and draws no button, which is how the negative case is
 * written.
 *
 * The real lookup runs `git ls-remote` against github.com, so it cannot appear in a test
 * at all. While the fixture is set no git runs and the sign-in detour is skipped — a
 * fixture browser has no GitHub cookie, and every click would otherwise land on the login
 * page instead of the address the case is about.
 *
 * Travels in the launch env, so it must be set BEFORE launchApp; a spec that starts from
 * the standard fixture app has to close it and relaunch (the `setGuestLimit` pattern).
 */
export function setGithubFixture(
  env: E2EEnv,
  repos: Record<string, { owner: string; repo: string; branch?: string; pr?: number } | null>
): void {
  env.launchEnv.KOLOFT_GITHUB_FIXTURE = JSON.stringify(repos)
}

/**
 * Write a fake launch wrapper: record the argv it was called
 * with, then exec `claude` on PATH so the REAL shim still intercepts (PATH is re-pinned
 * shim-first/fake-second inside the wrapper, because a login shell's path_helper can
 * reorder what Koloft handed the pty). Returns the bare command name for
 * settings.claudeCommand — it lands in `fakeBin`, which is on the app's PATH.
 *
 * Deliberately NOT created by setupE2EEnv: a spec that needs a *broken* claudeCommand
 * just names the wrapper in settings and calls this later, when it wants it to work.
 */
export function writeClaudeWrapper(env: E2EEnv, name = 'koloft-e2e-wrapper'): string {
  const file = path.join(env.fakeBin, name)
  fs.writeFileSync(
    file,
    `#!/usr/bin/env bash\n` +
      `printf '%s\\n' "$*" >> "${env.wrapperCalls}"\n` +
      `export PATH="${env.shimDir}:${env.fakeBin}:$PATH"\n` +
      `hash -r\n` +
      `exec claude "$@"\n`,
    { mode: 0o755 }
  )
  fs.chmodSync(file, 0o755)
  return name
}
