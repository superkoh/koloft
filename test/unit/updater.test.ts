import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { PassThrough } from 'stream'

const h = vi.hoisted(() => ({
  exe: '',
  running: '0.4.4',
  release: '',
  packaged: true,
  githubUnreachable: false,
  statusQueue: [] as number[],
  relaunches: 0,
  quits: 0,
  mountedDmgHoldsApp: false,
  spawns: 0
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
      if (h.githubUnreachable) {
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

vi.mock('child_process', async () => {
  const fs = await import('fs')
  const path = await import('path')
  return {
    execFile: (cmd: string, args: string[], cb: (e: Error | null) => void) => {
      if (h.mountedDmgHoldsApp && cmd === 'hdiutil' && args[0] === 'attach') {
        const mountpoint = args[args.indexOf('-mountpoint') + 1]
        fs.mkdirSync(path.join(mountpoint, 'Koloft.app'), { recursive: true })
      }
      cb(null)
    },
    spawn: () => {
      h.spawns++
      return { unref: () => {} }
    }
  }
})

let up: typeof import('../../src/main/updater')
async function importUpdaterWithFreshModuleState(): Promise<
  typeof import('../../src/main/updater')
> {
  vi.resetModules()
  return import('../../src/main/updater')
}
beforeEach(async () => {
  up = await importUpdaterWithFreshModuleState()
})

const tmpRoots: string[] = []
afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true })
})

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
  h.githubUnreachable = false
  h.statusQueue = []
  h.mountedDmgHoldsApp = false
  h.spawns = 0
})

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
    installBundle('0.5.0')
    h.running = '0.4.4'
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

  it('falls back to the running version when the bundle version cannot be read, leaving installed unknown rather than guessed', async () => {
    installBundle(null)
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    const r = await up.checkForUpdates()
    expect(r.status).toBe('available')
    expect(r.installed).toBeUndefined()
  })

  it('still reports a pending restart when the releases API is unreachable — that signal is local', async () => {
    installBundle('0.5.0')
    h.running = '0.4.4'
    h.githubUnreachable = true
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
    h.githubUnreachable = true
    await expect(up.checkForUpdates()).rejects.toThrow()
  })

  it('still reports a pending restart when the release carries no installable dmg yet', async () => {
    installBundle('0.5.0')
    h.running = '0.4.4'
    publishReleases({ tag_name: 'v0.5.0', assets: [] })
    const r = await up.checkForUpdates()
    expect(r.status).toBe('restart-required')
    expect(r.installed).toBe('0.5.0')
  })

  it('picks the newest PUBLISHED release, ignoring the drafts and prereleases the list endpoint returns', async () => {
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
    expect(r.status).toBe('available')
    expect(r.releases).toEqual([])
  })

  it('rejects a release payload that is not a list', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    h.release = JSON.stringify({ tag_name: 'v0.5.0' })
    await expect(up.checkForUpdates()).rejects.toThrow(/unexpected release list/i)
  })

  it('reads the inner bundle when Koloft.app is nested inside a wrapper .app — the one it runs from and the installer overwrites', async () => {
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
    expect((await up.checkForUpdates()).status).toBe('current')
  })

  it("ignores the host bundle when running unpackaged (dev), whose Info.plist declares Electron's own version", async () => {
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

  it('offers the on-disk version as the upgrade source when disk is behind the process', async () => {
    installBundle('0.4.4')
    h.running = '0.5.0'
    publishRelease('v0.5.0')
    const r = await up.checkForUpdates()
    expect(r.status).toBe('available')
    expect(r.installed).toBe('0.4.4')
    expect(r.latest).toBe('0.5.0')
    expect(r.installed).not.toBe(r.latest)
  })
})

describe('the dev-only fixture seam KOLOFT_UPDATE_FIXTURE: a packaged app never takes update metadata from a local file', () => {
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
    publishRelease('v0.5.0')
    expect((await up.checkForUpdates()).latest).toBe('0.5.0')
  })

  it('replaces the network for an unpackaged run', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    h.packaged = false
    h.githubUnreachable = true
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
  it('arms the relaunch once, as each call queues another instance, but keeps retrying the quit so one vetoed quit never leaves Restart inert', () => {
    up.restartApp()
    expect(h.relaunches).toBe(1)
    expect(h.quits).toBe(1)

    up.restartApp()
    expect(h.relaunches).toBe(1)
    expect(h.quits).toBe(2)
  })

  it('still arms the relaunch when a stalled install left the latch set — that installer gave up and will not reopen us', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    await up.checkForUpdates()
    const inflight = up.downloadAndInstall(() => {})

    up.restartApp()
    expect(h.relaunches).toBe(1)
    expect(h.quits).toBe(1)

    await expect(inflight).rejects.toThrow()
  })

  it('arms the relaunch only after the unsaved-changes answer, so a cancelled restart leaves no relaunch for the next ordinary quit to fire', async () => {
    const guard = await import('../../src/main/quitGuard')
    guard.setQuitAsk(() => true)

    up.restartApp()
    expect(h.relaunches).toBe(0)
    expect(h.quits).toBe(0)

    guard.declineQuit()
    const plainQuit = vi.fn()
    guard.approveAndRun(plainQuit)
    expect(plainQuit).toHaveBeenCalledOnce()
    expect(h.relaunches).toBe(0)
  })
})

describe('installing a downloaded update over the running app', () => {
  it('spawns the detached installer only after the unsaved-changes answer; a cancel spawns nothing and frees Install to run again', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    h.mountedDmgHoldsApp = true
    publishRelease('v0.5.0')
    await up.checkForUpdates()
    const guard = await import('../../src/main/quitGuard')
    guard.setQuitAsk(() => true)

    await expect(up.downloadAndInstall(() => {})).resolves.toBeUndefined()
    expect(h.spawns).toBe(0)

    guard.declineQuit()
    expect(h.spawns).toBe(0)

    guard.setQuitAsk(() => false)
    await expect(up.downloadAndInstall(() => {})).resolves.toBeUndefined()
    expect(h.spawns).toBe(1)
    await vi.waitFor(() => expect(h.quits).toBe(1))
  })
})

describe('confirming a download that another route installed while the modal sat open', () => {
  it('answers restart-required instead of reinstalling the same version', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    expect((await up.checkForUpdates()).status).toBe('available')

    fs.writeFileSync(path.join(path.dirname(path.dirname(h.exe)), 'Info.plist'), plistFor('0.5.0'))

    const bytes: number[] = []
    const r = await up.downloadAndInstall((p) => bytes.push(p.transferred))
    expect(r?.status).toBe('restart-required')
    expect(r?.installed).toBe('0.5.0')
    expect(bytes).toEqual([])
  })

  it('leaves the install latch clear so a later check still works', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    await up.checkForUpdates()
    fs.writeFileSync(path.join(path.dirname(path.dirname(h.exe)), 'Info.plist'), plistFor('0.5.0'))

    expect((await up.downloadAndInstall(() => {}))?.status).toBe('restart-required')
    expect((await up.checkForUpdates()).status).toBe('restart-required')
  })

  it('answers current, not restart-required, when disk matches the running version — a restart would kill every pty for the same version', async () => {
    installBundle('0.4.4')
    h.running = '0.5.0'
    publishRelease('v0.5.0')
    expect((await up.checkForUpdates()).status).toBe('available')
    fs.writeFileSync(path.join(path.dirname(path.dirname(h.exe)), 'Info.plist'), plistFor('0.5.0'))

    const r = await up.downloadAndInstall(() => {})
    expect(r?.status).toBe('current')
  })

  it('rejects a second confirm that lands while the first is still starting, so two installers never race the bundle swap', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    expect((await up.checkForUpdates()).status).toBe('available')

    const first = up.downloadAndInstall(() => {})
    const second = up.downloadAndInstall(() => {})
    await expect(second).rejects.toThrow(/already in progress/)
    await expect(first).rejects.toThrow()
  })
})

describe('releasePageUrl (R3): the url the in-app release overlay loads — fallback and scheme guard are unreachable from e2e', () => {
  it('falls back to the public releases index before any check has run', () => {
    expect(up.releasePageUrl()).toBe('https://github.com/superkoh/koloft-releases/releases')
  })

  it('points at the same releases repo that install.sh downloads from', () => {
    const script = fs.readFileSync(path.resolve(__dirname, '../../install.sh'), 'utf8')
    const repo = /^REPO="([^"]+)"/m.exec(script)?.[1]
    expect(repo).toBeTruthy()
    expect(up.releasePageUrl()).toBe(`https://github.com/${repo}/releases`)
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

describe('BB-20: the dmg fallback when the bundle cannot be replaced in place', () => {
  it('hands the downloaded installer, staged under its version name, to the one OS choke point', async () => {
    installBundle('0.4.4')
    h.running = '0.4.4'
    publishRelease('v0.5.0')
    await up.checkForUpdates()

    const bundle = path.dirname(path.dirname(path.dirname(h.exe)))
    const parent = path.dirname(bundle)
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-leave-')), 'external.txt')
    process.env.KOLOFT_EXTERNAL_OPENS_FILE = log
    process.env.KOLOFT_SUPPRESS_OS_OPEN = '1'
    fs.chmodSync(parent, 0o555)
    try {
      await expect(up.downloadAndInstall(() => {})).rejects.toThrow(/isn't writable/)
      await vi.waitFor(() => {
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
  it('every update channel the preload calls is handled in main with the matching shape (send↔on, invoke↔handle), or Restart Now goes silently inert', () => {
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
