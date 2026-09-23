import { app, shell } from 'electron'
import { spawn, execFile } from 'child_process'
import https from 'https'
import type { IncomingMessage } from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { UpdateCheckResult, UpdateProgress } from '@shared/types'
import { isNewer, notesSince, sortReleases, versionOf, type GhRelease } from './releaseNotes'
import { leaveForOS } from './osOpen'
import { withApproval } from './quitGuard'
import { INSTALL_SCRIPT, pickAppBundle } from './updaterInstall'

const REPO = 'superkoh/koloft-releases'
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=100`
const USER_AGENT_GITHUB_REQUIRES = 'Koloft-Updater'

let pending: { version: string; dmgUrl: string; htmlUrl: string } | null = null
let installing = false

const MAX_REDIRECTS = 5

// PLATFORM§32 PLATFORM§27
function getFollowing(
  url: string,
  accept: string,
  onResponse: (res: IncomingMessage) => void,
  onError: (e: Error) => void,
  redirects = 0
): void {
  if (redirects > MAX_REDIRECTS) {
    onError(new Error('Too many redirects'))
    return
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    onError(new Error('Invalid update URL'))
    return
  }
  if (parsed.protocol !== 'https:') {
    onError(new Error(`Refusing non-HTTPS update URL (${parsed.protocol})`))
    return
  }
  try {
    const req = https.get(
      url,
      { headers: { 'User-Agent': USER_AGENT_GITHUB_REQUIRES, Accept: accept } },
      (res) => {
        const sc = res.statusCode ?? 0
        if (sc >= 300 && sc < 400 && res.headers.location) {
          res.resume()
          let next: string
          try {
            next = new URL(res.headers.location, url).toString()
          } catch {
            onError(new Error('Invalid redirect location'))
            return
          }
          getFollowing(next, accept, onResponse, onError, redirects + 1)
          return
        }
        onResponse(res)
      }
    )
    req.on('error', onError)
  } catch (e) {
    onError(e as Error)
  }
}

// PLATFORM§32
const RETRY_DELAY_MS = 1500

function fetchJson<T>(url: string, retried = false): Promise<T> {
  return new Promise((resolve, reject) => {
    getFollowing(
      url,
      'application/vnd.github+json',
      (res) => {
        const sc = res.statusCode ?? 0
        if (sc >= 500 && !retried) {
          res.resume()
          setTimeout(() => fetchJson<T>(url, true).then(resolve, reject), RETRY_DELAY_MS)
          return
        }
        if (sc !== 200) {
          res.resume()
          reject(new Error(`GitHub API returned HTTP ${sc}`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            reject(new Error('Could not parse the GitHub API response'))
          }
        })
        res.on('error', reject)
      },
      reject
    )
  })
}

// PLATFORM§3
function downloadTo(
  url: string,
  dest: string,
  onProgress: (p: UpdateProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    getFollowing(
      url,
      'application/octet-stream',
      (res) => {
        if ((res.statusCode ?? 0) !== 200) {
          res.resume()
          reject(new Error(`Download failed (HTTP ${res.statusCode})`))
          return
        }
        const total = parseInt((res.headers['content-length'] as string) || '0', 10)
        let transferred = 0
        let lastPct = -2
        const file = fs.createWriteStream(dest)
        res.on('data', (c: Buffer) => {
          transferred += c.length
          const percent = total > 0 ? Math.floor((transferred / total) * 100) : -1
          if (percent !== lastPct) {
            lastPct = percent
            onProgress({ percent, transferred, total })
          }
        })
        res.on('error', (e) => {
          file.destroy()
          reject(e)
        })
        file.on('error', reject)
        file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())))
        res.pipe(file)
      },
      reject
    )
  })
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
  })
}

async function isWritable(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function fixturePath(): string | null {
  if (app.isPackaged) return null
  return process.env.KOLOFT_UPDATE_FIXTURE || null
}

const FEED_TTL_MS = 60_000
let feed: { at: number; list: GhRelease[] } | null = null

export async function fetchPublishedReleases(): Promise<GhRelease[]> {
  const fixture = fixturePath()
  let list: unknown
  if (fixture) {
    try {
      list = JSON.parse(await fs.promises.readFile(fixture, 'utf8'))
    } catch {
      throw new Error(`Could not read the update fixture at ${fixture}`)
    }
  } else {
    if (feed && Date.now() - feed.at < FEED_TTL_MS) return feed.list
    list = await fetchJson<unknown>(RELEASES_API)
  }
  if (!Array.isArray(list)) throw new Error('GitHub returned an unexpected release list.')
  const sorted = sortReleases(list as GhRelease[])
  if (!fixture) feed = { at: Date.now(), list: sorted }
  return sorted
}

function appBundlePath(): string | null {
  const exe = app.getPath('exe')
  const idx = exe.lastIndexOf('/Contents/MacOS/')
  return idx > 0 ? exe.slice(0, idx) : null
}

async function installedVersion(): Promise<string | null> {
  if (!app.isPackaged) return null
  const bundle = appBundlePath()
  if (!bundle) return null
  try {
    const plist = await fs.promises.readFile(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)
    return m?.[1].trim() || null
  } catch {
    return null
  }
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  const onDisk = await installedVersion()
  const basis = onDisk ?? current
  const restartPending = onDisk !== null && isNewer(onDisk, current)
  const restartResult = (): UpdateCheckResult => ({
    status: 'restart-required',
    current,
    installed: onDisk as string
  })

  if (installing) {
    if (restartPending) return restartResult()
    throw new Error('An update is already being installed.')
  }

  let published: GhRelease[]
  try {
    published = await fetchPublishedReleases()
  } catch (e) {
    if (restartPending) return restartResult()
    throw e
  }
  const rel = published[0]
  const latest = rel ? versionOf(rel) : ''
  const dmg = rel?.assets?.find((a) => /-arm64\.dmg$/.test(a.name))
  if (!latest || !dmg) {
    if (restartPending) return restartResult()
    throw new Error('No installable arm64 .dmg was found in the latest release.')
  }
  pending = { version: latest, dmgUrl: dmg.browser_download_url, htmlUrl: rel.html_url || '' }
  if (!isNewer(latest, basis)) {
    return restartPending
      ? restartResult()
      : { status: 'current', current, installed: onDisk ?? undefined }
  }
  const { releases, omittedReleases } = notesSince(published, basis)
  return {
    status: 'available',
    current,
    installed: onDisk ?? undefined,
    latest,
    releases,
    omittedReleases,
    htmlUrl: rel.html_url
  }
}

let relaunching = false

export function restartApp(): void {
  withApproval(() => {
    if (!relaunching) {
      relaunching = true
      app.relaunch()
    }
    app.quit()
  }, Date.now())
}

export function releasePageUrl(): string {
  const url = pending?.htmlUrl
  if (url && /^https?:\/\//i.test(url)) return url
  return process.env.KOLOFT_RELEASES_URL || `https://github.com/${REPO}/releases`
}

async function sweepStaleWorkDirs(): Promise<void> {
  const tmp = os.tmpdir()
  try {
    const entries = await fs.promises.readdir(tmp)
    await Promise.all(
      entries
        .filter((n) => n.startsWith('koloft-update-'))
        .map((n) =>
          fs.promises.rm(path.join(tmp, n), { recursive: true, force: true }).catch(() => {})
        )
    )
  } catch {}
}

const INSTALLER_HEAD_START_MS = 400

// ADR-0006
export async function downloadAndInstall(
  onProgress: (p: UpdateProgress) => void
): Promise<UpdateCheckResult | undefined> {
  if (!app.isPackaged) throw new Error('Updates can only be installed from the packaged app.')
  if (!pending) throw new Error('No update is staged — run a check first.')
  if (installing) throw new Error('An update is already in progress.')
  const bundle = appBundlePath()
  if (!bundle) throw new Error('Could not locate the running Koloft.app bundle.')

  installing = true
  let work: string | null = null
  let keepWork = false
  try {
    const onDisk = await installedVersion()
    if (onDisk && !isNewer(pending.version, onDisk)) {
      installing = false
      const running = app.getVersion()
      return isNewer(onDisk, running)
        ? { status: 'restart-required', current: running, installed: onDisk }
        : { status: 'current', current: running, installed: onDisk }
    }
    await sweepStaleWorkDirs()
    work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'koloft-update-'))
    const dmgPath = path.join(work, `Koloft-${pending.version}.dmg`)
    await downloadTo(pending.dmgUrl, dmgPath, onProgress)
    onProgress({ percent: 100, transferred: 0, total: 0 })

    const canWrite = (await isWritable(bundle)) && (await isWritable(path.dirname(bundle)))
    if (!canWrite) {
      keepWork = true
      const openErr = await leaveForOS(dmgPath, 'path')
      throw new Error(
        openErr
          ? `Koloft isn't writable at ${bundle}, and the installer couldn't be opened automatically. Download it from ${pending.htmlUrl || 'the releases page'} and drag Koloft into Applications.`
          : `Koloft isn't writable at ${bundle}. Opened the installer — drag Koloft into Applications, then reopen.`
      )
    }

    const mnt = path.join(work, 'mnt')
    await fs.promises.mkdir(mnt, { recursive: true })
    await run('hdiutil', ['attach', dmgPath, '-nobrowse', '-quiet', '-mountpoint', mnt])
    let stagedApp: string
    try {
      const appName = pickAppBundle(await fs.promises.readdir(mnt))
      if (!appName) throw new Error('The downloaded dmg contains no .app bundle.')
      stagedApp = path.join(work, 'staging', appName)
      await fs.promises.mkdir(path.dirname(stagedApp), { recursive: true })
      await run('cp', ['-R', path.join(mnt, appName), stagedApp])
    } finally {
      await run('hdiutil', ['detach', mnt, '-quiet']).catch(() => {})
    }
    const dest = path.join(path.dirname(bundle), path.basename(stagedApp))
    const oldBundle = dest === bundle ? '' : bundle

    const scriptPath = path.join(work, 'install.sh')
    await fs.promises.writeFile(scriptPath, INSTALL_SCRIPT, { mode: 0o755 })
    keepWork = true
    const workDir = work

    withApproval(
      () => {
        const child = spawn(
          '/bin/bash',
          [scriptPath, String(process.pid), stagedApp, dest, workDir, oldBundle],
          { detached: true, stdio: 'ignore' }
        )
        child.unref()
        setTimeout(() => app.quit(), INSTALLER_HEAD_START_MS)
      },
      Date.now(),
      () => {
        installing = false
      }
    )
    return undefined
  } catch (e) {
    installing = false
    if (work && !keepWork) {
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {})
    }
    throw e
  }
}
