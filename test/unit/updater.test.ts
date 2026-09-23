import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { PassThrough } from 'stream'

// The question the check has to answer is "is there something left to INSTALL?", and the
// answer lives on disk: Koloft can be replaced while it runs (a dragged-in dmg, install.sh, a
// self-update whose relaunch re-activated the old instance), after which the running
// process reports a version older than the bundle it launched from. So the fixture is a
// real Koloft.app skeleton whose Info.plist and running version are set independently, plus a
// canned GitHub /releases reply (a LIST — the check reads every release so the modal can show
// the changelog of each version the user skipped).
const h = vi.hoisted(() => ({
  exe: '',
  running: '0.4.4',
  release: '',
  packaged: true,
  failRequests: false,
  /** HTTP status the next responses answer with, shifted off one per request (default 200) */
  statusQueue: [] as number[],
  relaunches: 0,
  quits: 0
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => h.running,
    getPath: () => h.exe,
    get isPackaged() {
      return h.packaged
    },
    relaunch: () => {
      h.relaunches++
    },
    quit: () => {
      h.quits++
    }
  },
  shell: { openExternal: () => {}, openPath: async () => '' }
}))

vi.mock('https', () => {
  const get = (
    _url: string,
    _opts: unknown,
    cb: (res: PassThrough) => void
  ): { on: (ev: string, fn: (e: Error) => void) => void } => {
    const res = new PassThrough() as PassThrough & {
      statusCode: number
      headers: Record<string, string>
    }
    res.statusCode = 200
    res.headers = {}
    const handlers: Record<string, (e: Error) => void> = {}
    setImmediate(() => {
      // models offline / rate-limited GitHub: the request errors instead of responding
      if (h.failRequests) {
        handlers.error?.(new Error('getaddrinfo ENOTFOUND api.github.com'))
        return
      }
      res.statusCode = h.statusQueue.shift() ?? 200
      cb(res)
      res.end(res.statusCode === 200 ? h.release : 'Gateway Timeout')
    })
    return {
      on: (ev: string, fn: (e: Error) => void) => {
        handlers[ev] = fn
      }
    }
  }
  return { default: { get }, get }
})

// Keep the install path off real subprocesses: hdiutil/cp/bash would run for real otherwise.
// The staging then fails on the missing mount, which is all these tests need — they pin the
// single-flight latch, not the swap.
vi.mock('child_process', () => ({
  execFile: (_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(null),
  spawn: () => ({ unref: () => {} })
}))

// updater.ts keeps module-level state (`installing`, `relaunching`, the staged `pending`).
// Re-import it fresh for every test so no assertion depends on which describe ran first —
// the latch tests below are meaningless against state a sibling test happened to leave.
let up: typeof import('../../src/main/updater')
beforeEach(async () => {
  vi.resetModules()
  up = await import('../../src/main/updater')
})

const tmpRoots: string[] = []
afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true })
})

/** Stand up an app bundle whose Info.plist declares `version` (null = no plist at all), and
 *  point the fake `app.getPath('exe')` at its executable. `name` models what the process
 *  actually runs from: Koloft.app when installed, Electron.app under `npm run dev`. */
function installBundle(version: string | null, name = 'Koloft'): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-updater-'))
  tmpRoots.push(root)
  const bundle = path.join(root, `${name}.app`)
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', name), '')
  if (version !== null) {
    fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), plistFor(version))
  }
  h.exe = path.join(bundle, 'Contents', 'MacOS', name)
}

/** One release entry shaped like the GitHub /releases list, with the notes layout
 *  scripts/release-notes.sh emits: changelog, install marker, install text. */
function release(tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const bare = tag.replace(/^v/, '')
  return {
    tag_name: tag,
    body: `## What's Changed\n\n- feat: landed in ${tag}\n\n<!-- koloft:install -->\ncurl … | bash`,
    html_url: `https://github.com/superkoh/koloft-releases/releases/tag/${tag}`,
    assets: [
      {
        name: `Koloft-${bare}-arm64.dmg`,
        browser_download_url: `https://example.invalid/Koloft-${bare}-arm64.dmg`
      }
    ],
    ...extra
  }
}

function publishReleases(...entries: Record<string, unknown>[]): void {
  h.release = JSON.stringify(entries)
}

function publishRelease(tag: string): void {
  publishReleases(release(tag))
}

beforeEach(() => {
  h.relaunches = 0
  h.quits = 0
  h.packaged = true
  h.failRequests = false
  h.statusQueue = []
})

/** the one-line XML plist shape electron-builder emits */
function plistFor(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string></dict></plist>\n`
}

describe('update check: what is left to install', () => {
  it('offers the update when the release is newer than the app on disk', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    const r = await up.checkForUpdates()
    expect(r.status).toBe('available')
    expect(r.latest).toBe('0.5.0')
    expect(r.current).toBe('0.4.4')
  })

  it('does NOT offer an update that is already installed (Koloft replaced while running)', async () => {
    installBundle('0.5.0') // the dmg already landed in /Applications…
    h.running = '0.4.4' // …but this process still runs the bundle it booted from
    publishRelease('v0.5.0')
    const r = await up.checkForUpdates()
    expect(r.status).not.toBe('available')
    expect(r.status).toBe('restart-required')
    expect(r.installed).toBe('0.5.0')
    expect(r.current).toBe('0.4.4')
  })

  it('reports current when the running app and the bundle are both the newest', async () => {
    installBundle('0.5.0')
    h.running = '0.5.0'
    publishRelease('v0.5.0')
    expect((await up.checkForUpdates()).status).toBe('current')
  })

  it('treats a v-prefixed tag as the same version as the bare number', async () => {
    installBundle('0.5.0')
    h.running = '0.5.0'
    publishRelease('v0.5.0')
    expect((await up.checkForUpdates()).status).toBe('current')
    publishRelease('0.5.0')
    expect((await up.checkForUpdates()).status).toBe('current')
  })

  it('never offers a downgrade to an older published release', async () => {
    installBundle('0.5.0')
    h.running = '0.5.0'
    publishRelease('v0.4.4')
    expect((await up.checkForUpdates()).status).toBe('current')
  })

  it('still offers a genuinely newer release while a restart is already pending', async () => {
    installBundle('0.5.0')
    h.running = '0.4.4'
    publishRelease('v0.6.0')
    const r = await up.checkForUpdates()
    expect(r.status).toBe('available')
    expect(r.latest).toBe('0.6.0')
  })

  it('falls back to the running version when the bundle version cannot be read', async () => {
    installBundle(null) // no Info.plist — must not silently suppress a real update
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    const r = await up.checkForUpdates()
    expect(r.status).toBe('available')
    // "disk unknown" must stay distinguishable from "disk == running": reporting the running
    // version as `installed` would present a guess as a verified on-disk fact.
    expect(r.installed).toBeUndefined()
  })

  // The whole restart signal (Info.plist vs app.getVersion()) is local, so an unreachable or
  // rate-limited GitHub must not hide it behind an API error the user can do nothing about.
  it('still reports a pending restart when the releases API is unreachable', async () => {
    installBundle('0.5.0')
    h.running = '0.4.4'
    h.failRequests = true
    const r = await up.checkForUpdates()
    expect(r.status).toBe('restart-required')
    expect(r.installed).toBe('0.5.0')
  })

  it('retries once when GitHub answers a transient 5xx, then reads the release', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    h.release = JSON.stringify([release('v0.5.0')])
    h.statusQueue = [504]
    const r = await up.checkForUpdates()
    expect(r.status).toBe('available')
    expect(r.latest).toBe('0.5.0')
  })

  it('gives up after the retry also fails with a 5xx', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    h.statusQueue = [504, 502]
    await expect(up.checkForUpdates()).rejects.toThrow(/HTTP 502/)
  })

  it('surfaces the API failure when there is no pending restart to report', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    h.failRequests = true
    await expect(up.checkForUpdates()).rejects.toThrow()
  })

  // Same reasoning as the unreachable API: a release still uploading its assets says nothing
  // about the newer bundle already sitting on disk.
  it('still reports a pending restart when the release carries no installable dmg', async () => {
    installBundle('0.5.0')
    h.running = '0.4.4'
    publishReleases({ tag_name: 'v0.5.0', assets: [] })
    const r = await up.checkForUpdates()
    expect(r.status).toBe('restart-required')
    expect(r.installed).toBe('0.5.0')
  })

  // The list endpoint hands back drafts and prereleases that /releases/latest used to filter
  // for us. Offering one would push an unfinished build at every user.
  it('picks the newest PUBLISHED release, ignoring drafts and prereleases', async () => {
    installBundle('0.5.0')
    h.running = '0.5.0'
    publishReleases(
      release('v0.9.0', { draft: true }),
      release('v0.8.0', { prerelease: true }),
      release('v0.6.0'),
      release('v0.5.0')
    )
    const r = await up.checkForUpdates()
    expect(r.status).toBe('available')
    expect(r.latest).toBe('0.6.0')
    expect(r.releases?.map((n) => n.version)).toEqual(['0.6.0'])
  })

  // The bug this whole change fixes: the modal showed the release body verbatim, which for
  // v0.3.2–v0.5.2 was install instructions and nothing else.
  it('returns the changelog of every skipped release, newest first, install text stripped', async () => {
    installBundle('0.5.0')
    h.running = '0.5.0'
    publishReleases(release('v0.5.2'), release('v0.6.0'), release('v0.5.1'), release('v0.5.0'))
    const r = await up.checkForUpdates()
    expect(r.releases?.map((n) => n.version)).toEqual(['0.6.0', '0.5.2', '0.5.1'])
    expect(r.releases?.[0].notes).toContain('- feat: landed in v0.6.0')
    for (const n of r.releases ?? []) expect(n.notes).not.toMatch(/curl|koloft:install/)
    expect(r.omittedReleases).toBe(0)
  })

  it('reports no changelog when every release body is the legacy install-only text', async () => {
    installBundle('0.5.0')
    h.running = '0.5.0'
    publishReleases(
      release('v0.6.0', { body: '**未签名个人构建 (macOS arm64, unsigned).** …curl…' })
    )
    const r = await up.checkForUpdates()
    // still an offer — just nothing to say about it
    expect(r.status).toBe('available')
    expect(r.releases).toEqual([])
  })

  it('rejects a release payload that is not a list', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    h.release = JSON.stringify({ tag_name: 'v0.5.0' }) // the old /latest shape
    await expect(up.checkForUpdates()).rejects.toThrow(/unexpected release list/i)
  })

  // appBundlePath must resolve the bundle we actually run from, not an enclosing wrapper —
  // it picks both the version we read and the bundle the installer overwrites.
  it('reads the inner bundle when Koloft.app is nested inside a wrapper .app', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-updater-'))
    tmpRoots.push(root)
    const inner = path.join(root, 'Wrapper.app', 'Contents', 'MacOS', 'Koloft.app')
    fs.mkdirSync(path.join(inner, 'Contents', 'MacOS'), { recursive: true })
    fs.writeFileSync(path.join(inner, 'Contents', 'MacOS', 'Koloft'), '')
    fs.writeFileSync(path.join(inner, 'Contents', 'Info.plist'), plistFor('0.5.0'))
    fs.mkdirSync(path.join(root, 'Wrapper.app', 'Contents'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Wrapper.app', 'Contents', 'Info.plist'), plistFor('9.9.9'))
    h.exe = path.join(inner, 'Contents', 'MacOS', 'Koloft')
    h.running = '0.5.0'
    publishRelease('v0.5.0')
    // the wrapper claims 9.9.9; reading it would report a version never installed
    expect((await up.checkForUpdates()).status).toBe('current')
  })

  // `npm run dev` runs from node_modules/electron/dist/Electron.app, whose Info.plist is
  // perfectly readable and declares ELECTRON's version — far above any Koloft release. Reading
  // it as "the installed Koloft" would pin every dev check to restart-required and hide real
  // releases, so an unpackaged run must not treat its host bundle as an installed Koloft.
  it('ignores the host bundle when running unpackaged (dev)', async () => {
    installBundle('33.4.11', 'Electron')
    h.packaged = false
    h.running = '0.5.0'
    publishRelease('v0.6.0')
    const r = await up.checkForUpdates()
    expect(r.status).toBe('available')
    expect(r.latest).toBe('0.6.0')
  })

  it('reports current in dev when the running version is already the newest', async () => {
    installBundle('33.4.11', 'Electron')
    h.packaged = false
    h.running = '0.5.0'
    publishRelease('v0.5.0')
    expect((await up.checkForUpdates()).status).toBe('current')
  })

  // A disk copy OLDER than this process (restore / synced Applications / pinned installer):
  // the upgrade arrow must name the version an install would actually replace, never render
  // a same-version or backwards hop.
  it('offers the on-disk version as the upgrade source when disk is behind the process', async () => {
    installBundle('0.4.4')
    h.running = '0.5.0'
    publishRelease('v0.5.0')
    const r = await up.checkForUpdates()
    expect(r.status).toBe('available')
    expect(r.installed).toBe('0.4.4')
    expect(r.latest).toBe('0.5.0')
    expect(r.installed).not.toBe(r.latest) // the arrow shows a real upgrade
  })
})

// KOLOFT_UPDATE_FIXTURE lets the E2E suite drive every modal state without the network. It is a
// dev-only seam by construction: a packaged app must never take update metadata from a local
// file, so the gate on app.isPackaged is the security-relevant half of this feature.
describe('the dev-only fixture seam', () => {
  let fixture: string
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-fixture-'))
    tmpRoots.push(dir)
    fixture = path.join(dir, 'releases.json')
    fs.writeFileSync(fixture, JSON.stringify([release('v9.9.9')]))
    process.env.KOLOFT_UPDATE_FIXTURE = fixture
  })
  afterEach(() => {
    delete process.env.KOLOFT_UPDATE_FIXTURE
  })

  it('is ignored by a packaged app, which still asks GitHub', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    h.packaged = true
    publishRelease('v0.5.0') // what the network says
    expect((await up.checkForUpdates()).latest).toBe('0.5.0') // …not the fixture's 9.9.9
  })

  it('replaces the network for an unpackaged run', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    h.packaged = false
    h.failRequests = true // proves no request was made
    const r = await up.checkForUpdates()
    expect(r.status).toBe('available')
    expect(r.latest).toBe('9.9.9')
  })

  it('surfaces an unreadable fixture as a check error', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    h.packaged = false
    process.env.KOLOFT_UPDATE_FIXTURE = path.join(path.dirname(fixture), 'missing.json')
    await expect(up.checkForUpdates()).rejects.toThrow(/fixture/i)
  })
})

describe('restart', () => {
  // Both halves live in one test because the latch is module state. The two rules pull in
  // opposite directions: app.relaunch() queues another instance per call and Koloft takes no
  // single-instance lock, so arming it twice returns two processes onto one userData — but
  // the quit itself must stay retryable, or a single vetoed attempt leaves the only restart
  // affordance permanently inert (and the quit failing is the very condition that produced
  // 'restart-required' in the first place).
  it('arms the relaunch once but keeps retrying the quit', () => {
    up.restartApp()
    expect(h.relaunches).toBe(1)
    expect(h.quits).toBe(1)

    up.restartApp() // clicked again because the first quit did not take
    expect(h.relaunches).toBe(1) // never a second instance
    expect(h.quits).toBe(2) // but the quit is retried
  })

  // The one state that makes Restart Now reachable while `installing` is still set is an
  // installer that gave up waiting on our PID and exited — so "it will reopen us" cannot be
  // assumed. Skipping the relaunch there quits Koloft for good.
  it('still arms the relaunch when a stalled install left the latch set', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    await up.checkForUpdates()
    const inflight = up.downloadAndInstall(() => {}) // latches `installing`

    up.restartApp()
    expect(h.relaunches).toBe(1)
    expect(h.quits).toBe(1)

    await expect(inflight).rejects.toThrow() // fails later on the fake mount
  })
})

// The Restart Now button is a fire-and-forget ipcRenderer.send: a channel-name mismatch
// between preload and main leaves it silently inert, with no rejection to surface. Nothing
// else in the suite crosses that boundary, so pin the two sides to the same string.
// The modal can sit on an "available" result for minutes while the bundle is replaced by
// another route. Confirming the download then must NOT re-fetch ~150MB to swap a version
// over itself — and must offer the restart, since an error screen's only button would just
// re-run the same download.
describe('confirming a download that is already installed', () => {
  it('answers restart-required instead of reinstalling the same version', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    expect((await up.checkForUpdates()).status).toBe('available') // stages pending = 0.5.0

    // …the dmg lands by another route while the modal is still open
    fs.writeFileSync(path.join(path.dirname(path.dirname(h.exe)), 'Info.plist'), plistFor('0.5.0'))

    const bytes: number[] = []
    const r = await up.downloadAndInstall((p) => bytes.push(p.transferred))
    expect(r?.status).toBe('restart-required')
    expect(r?.installed).toBe('0.5.0')
    expect(bytes).toEqual([]) // nothing was downloaded
  })

  // Self-contained on purpose: reading the latch after a sibling test's side effect would
  // pass vacuously under -t filtering or a reorder.
  it('leaves the install latch clear so a later check still works', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    await up.checkForUpdates()
    fs.writeFileSync(path.join(path.dirname(path.dirname(h.exe)), 'Info.plist'), plistFor('0.5.0'))

    expect((await up.downloadAndInstall(() => {}))?.status).toBe('restart-required')
    // holding the latch here would make every later check throw for the rest of the session
    expect((await up.checkForUpdates()).status).toBe('restart-required')
  })

  // A restart only means something when the disk copy is NEWER than this process; when they
  // already agree the release is simply running, and prompting would kill every pty to
  // relaunch into the identical version.
  it('answers current, not restart-required, when disk matches the running version', async () => {
    installBundle('0.4.4')
    h.running = '0.5.0'
    publishRelease('v0.5.0')
    expect((await up.checkForUpdates()).status).toBe('available') // stages pending = 0.5.0
    fs.writeFileSync(path.join(path.dirname(path.dirname(h.exe)), 'Info.plist'), plistFor('0.5.0'))

    const r = await up.downloadAndInstall(() => {})
    expect(r?.status).toBe('current')
  })

  // The latch has to close before the first await: any yield between the `installing` check
  // and the set lets a second confirm through, and two installers race the bundle swap —
  // each sweeping the other's work dir and clobbering the ${DEST}.old rollback.
  it('rejects a second confirm that lands while the first is still starting', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    expect((await up.checkForUpdates()).status).toBe('available')

    const first = up.downloadAndInstall(() => {}) // enters the await window
    const second = up.downloadAndInstall(() => {}) // must not get past the latch
    await expect(second).rejects.toThrow(/already in progress/)
    await expect(first).rejects.toThrow() // fails later on the fake mount — not what we pin
  })
})

/**
 * R3 — the release page moved INSIDE Koloft, so what used to be "which url did we
 * hand the OS" is now "which url does the overlay load". Unit-level because both the
 * fallback and the scheme guard are unreachable from e2e: one needs a run with no check
 * behind it, the other a tampered GitHub field.
 */
describe('releasePageUrl (R3)', () => {
  it('falls back to the public releases index before any check has run', () => {
    expect(up.releasePageUrl()).toBe('https://github.com/superkoh/koloft-releases/releases')
  })

  it('uses the page the last check cached', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    await up.checkForUpdates()
    expect(up.releasePageUrl()).toBe(
      'https://github.com/superkoh/koloft-releases/releases/tag/v0.5.0'
    )
  })

  it('refuses a non-http(s) cached url — a tampered API field never reaches a loader', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    publishReleases(release('v0.5.0', { html_url: 'file:///Applications/Evil.app' }))
    await up.checkForUpdates()
    expect(up.releasePageUrl()).toBe('https://github.com/superkoh/koloft-releases/releases')
  })
})

/**
 * BB-20 (P0) — the installer is the user leaving Koloft for Finder, and every such
 * hand-off goes through the one choke point, or a test run cannot see it happen at all
 * (this branch bypassed it: `shell.openPath` straight from the updater).
 */
describe('the dmg fallback when the bundle cannot be replaced in place', () => {
  it('hands the installer to the one OS choke point', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    await up.checkForUpdates()

    const bundle = path.dirname(path.dirname(path.dirname(h.exe)))
    const parent = path.dirname(bundle)
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-leave-')), 'external.txt')
    process.env.KOLOFT_EXTERNAL_OPENS_FILE = log
    process.env.KOLOFT_SUPPRESS_OS_OPEN = '1' // never launch a real installer from a test
    fs.chmodSync(parent, 0o555) // …so the in-place swap is refused
    try {
      await expect(up.downloadAndInstall(() => {})).rejects.toThrow(/isn't writable/)
      await vi.waitFor(() => {
        // the file the updater downloaded to (it names the staged copy by version, not
        // by the asset's own filename)
        expect(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').toContain('Koloft-0.5.0.dmg')
      })
    } finally {
      fs.chmodSync(parent, 0o755)
      delete process.env.KOLOFT_EXTERNAL_OPENS_FILE
      delete process.env.KOLOFT_SUPPRESS_OS_OPEN
    }
  })
})

describe('update IPC wiring', () => {
  // Name equality is not enough: `invoke` against an `ipcMain.on` handler returns a promise
  // that never settles, so Restart Now would hang on "Restarting…" with no error — as silent
  // as the typo this guards. Pin the call SHAPE too (send↔on, invoke↔handle).
  it('every update channel the preload calls is handled in main with the matching shape', () => {
    const root = path.resolve(__dirname, '../..')
    const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
    const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
    const sent = [...preload.matchAll(/ipcRenderer\.(send|invoke)\('(update:[^']+)'/g)].map(
      (m) => `${m[2]} via ${m[1] === 'send' ? 'on' : 'handle'}`
    )
    const handled = new Set(
      [...main.matchAll(/ipcMain\.(on|handle)\('(update:[^']+)'/g)].map(
        (m) => `${m[2]} via ${m[1]}`
      )
    )
    expect(sent).toContain('update:restart via on')
    expect(sent.filter((c) => !handled.has(c))).toEqual([])
  })
})
