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

// Why a DIY updater instead of electron-updater/Squirrel: Koloft ships unsigned by policy,
// and both hard-require code signing on macOS — quitAndInstall silently fails on an
// unsigned app. Hence: Node-side fetch (the downloaded file carries no quarantine attr),
// then a detached script swaps the bundle after our PID dies.
// Binaries live in their own repo, apart from the source. This mirrors install.sh's REPO.
const REPO = 'superkoh/koloft-releases'
// The LIST endpoint, not /releases/latest: the modal shows the changelog of every release
// the user skipped, which needs all of them. Still a single request — the list carries each
// release's body and assets — but it also includes drafts/prereleases that /latest filtered
// for us, so sortReleases() (in releaseNotes.ts) has to drop those itself.
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=100`
// GitHub rejects API requests without a User-Agent.
const UA = 'Koloft-Updater'

// The dmg resolved by the last successful check, so download() never trusts a
// renderer-supplied URL. Set on every check (even when already current).
let pending: { version: string; dmgUrl: string; htmlUrl: string } | null = null
// single-flight: re-opening the menu mid-download can re-offer the update, so guard
// against two concurrent installs racing on the same bundle. Reset on failure so a
// retry works; on success the process quits, so it stays set.
let installing = false

/** GET `url`, following up to 5 redirects (GitHub asset URLs 302 to a signed S3 host),
 *  handing the final response stream to `onResponse`. Every error path — a malformed or
 *  non-HTTPS redirect target, or a synchronous throw from https.get — is routed to
 *  `onError`. (https.get throws *synchronously* on a non-https URL, and that throw fires
 *  inside the parent response callback during a redirect, where it would otherwise escape
 *  to an uncaughtException and leave the promise hung.) */
function getFollowing(
  url: string,
  accept: string,
  onResponse: (res: IncomingMessage) => void,
  onError: (e: Error) => void,
  redirects = 0
): void {
  if (redirects > 5) {
    onError(new Error('Too many redirects'))
    return
  }
  // Only HTTPS — refuse a downgrade hop rather than letting https.get throw on it.
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
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: accept } }, (res) => {
      const sc = res.statusCode ?? 0
      if (sc >= 300 && sc < 400 && res.headers.location) {
        res.resume() // drain so the socket frees
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
    })
    req.on('error', onError)
  } catch (e) {
    onError(e as Error)
  }
}

// GitHub's edge answers a 5xx (observed: 504 on the releases list, 2026-09) for one request and
// 200 for the next; one retry after a short pause turns that blip into a normal check instead
// of an error the user has to dismiss and click "Try again" on.
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
        // a mid-stream response error won't close the file stream on its own — destroy it
        // so we don't leak the fd / leave a half-written dmg holding a handle.
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

/** Dev/test-only metadata source: `KOLOFT_UPDATE_FIXTURE=<file>` makes a check read a local
 *  JSON array shaped like the GitHub /releases response instead of going to the network, so
 *  the E2E suite can drive every modal state deterministically. Ignored in a packaged app —
 *  the shipped updater has no local-file path to trust for update metadata. */
export function fixturePath(): string | null {
  if (app.isPackaged) return null
  return process.env.KOLOFT_UPDATE_FIXTURE || null
}

// A launch asks the same question twice within a second or so — "what's new" as the
// renderer boots, then the notifier's first tick — and one anonymous GitHub call is worth
// keeping for both. Short enough that a "Check for Updates…" a minute later is still live.
// The FIXTURE is never cached: specs rewrite that file between checks of one launch.
const FEED_TTL_MS = 60_000
let feed: { at: number; list: GhRelease[] } | null = null

/** Published releases, newest first. */
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

/** The running app's .app bundle, derived from the executable path
 *  (`/Applications/Koloft.app/Contents/MacOS/Koloft` → `/Applications/Koloft.app`). Anchors on the
 *  bundle-internal `/Contents/MacOS/` so a `.app` substring elsewhere in the path (e.g. a
 *  home dir literally named `foo.app`) can't false-match — and on the LAST occurrence, so a
 *  bundle nested inside another one (a wrapper/launcher .app) resolves to the inner bundle
 *  we actually run from rather than the wrapper. null when not inside a bundle
 *  (dev / non-mac layout). */
function appBundlePath(): string | null {
  const exe = app.getPath('exe')
  const idx = exe.lastIndexOf('/Contents/MacOS/')
  return idx > 0 ? exe.slice(0, idx) : null
}

/** Version of the Koloft bundle that is on disk *right now*, read from its Info.plist.
 *  `app.getVersion()` is fixed when the process starts, so an app replaced while it runs —
 *  a dragged-in dmg, install.sh, or a self-update whose relaunch re-activated the still-live
 *  old instance — keeps reporting the version it booted with, and the check would go on
 *  offering a release the user already has installed. Info.plist (not the asar's
 *  package.json) is the source: it's a plain file read with no in-process caching, so it
 *  can't hand back the bundle we booted from. null when unreadable — the caller then falls
 *  back to the running version so a real update is never suppressed. */
async function installedVersion(): Promise<string | null> {
  // Unpackaged runs execute from node_modules/electron/dist/Electron.app, whose Info.plist
  // carries *Electron's* version — reading it would report a bogus installed Koloft (always
  // newer than any release, so every dev check would claim a restart is pending).
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
  // null when the disk version is genuinely unknown (dev, unreadable plist) — kept distinct
  // from "disk equals the running version" so `installed` is only ever reported as a fact we
  // actually read. `basis` is what the install decision compares against.
  const onDisk = await installedVersion()
  const basis = onDisk ?? current
  // A newer bundle already on disk is purely local knowledge: no network needed to know a
  // restart is what's pending.
  const restartPending = onDisk !== null && isNewer(onDisk, current)
  const restartResult = (): UpdateCheckResult => ({
    status: 'restart-required',
    current,
    installed: onDisk as string
  })

  if (installing) {
    // The swap can land while this process survives the quit (the installer stops waiting
    // after 30s and `open` then just re-activates us). That's precisely when a restart is
    // the answer, so report it rather than the mid-flight error.
    if (restartPending) return restartResult()
    // Otherwise an install really is in progress (incl. the window after app.quit() is
    // scheduled) — a fresh "available" result would invite a conflicting second flow.
    throw new Error('An update is already being installed.')
  }

  let published: GhRelease[]
  try {
    published = await fetchPublishedReleases()
  } catch (e) {
    // Offline / rate-limited / captive portal: an already-installed newer bundle still needs
    // a restart, and an API error the user can do nothing about would hide that.
    if (restartPending) return restartResult()
    throw e
  }
  const rel = published[0]
  const latest = rel ? versionOf(rel) : ''
  const dmg = rel?.assets?.find((a) => /-arm64\.dmg$/.test(a.name))
  if (!latest || !dmg) {
    // Same reasoning as the fetch failure above: a release still uploading its assets (or
    // published without the dmg target) says nothing about the newer bundle already on disk.
    if (restartPending) return restartResult()
    throw new Error('No installable arm64 .dmg was found in the latest release.')
  }
  pending = { version: latest, dmgUrl: dmg.browser_download_url, htmlUrl: rel.html_url || '' }
  // Compare against what's on disk: that's the bundle an install would replace, and the one
  // the next launch runs. Downloading again when it's already the newest would reinstall
  // the same dmg and leave the user back here.
  if (!isNewer(latest, basis)) {
    // Newest is installed but this process is older — the update landed, the relaunch
    // didn't. Say that instead of "you're current", whose version number would contradict
    // the stale one the About panel shows.
    return restartPending
      ? restartResult()
      : { status: 'current', current, installed: onDisk ?? undefined }
  }
  // `installed` rides along so the modal's upgrade arrow shows the version an install would
  // actually replace. It differs from `current` only when the disk copy is OLDER than this
  // process (a restore/downgrade underneath us), where reporting the running version would
  // render a same-version — or backwards — arrow.
  // Spanned from `basis` (not from `latest`): the changelog covers everything the user
  // hasn't got yet, so skipping v0.5.1 → v0.5.3 lists both releases, not just the newest.
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

// app.relaunch() queues another instance for after this one exits, so arming it twice brings
// back two processes sharing one userData — duplicate windows racing on layout.json and the
// registration dirs. Arm once; the quit itself stays retryable.
let relaunching = false

/** Relaunch into the bundle on disk — the way out of 'restart-required'. */
export function restartApp(): void {
  // Always arm the relaunch, including mid-install. The one state that makes this button
  // reachable while `installing` is set is an installer that already gave up waiting on our
  // PID and exited, so "the installer will reopen us" cannot be assumed — skipping the
  // relaunch there quits Koloft for good.
  // file-edit B-26: arm the relaunch only once the unsaved question has been answered.
  // `app.relaunch()` cannot be taken back, so arming it first meant a user who cancelled
  // got Koloft reopening itself at their next ordinary quit.
  withApproval(() => {
    if (!relaunching) {
      relaunching = true
      app.relaunch()
    }
    // Always retry the quit: a vetoed or stalled first attempt must not leave the only
    // restart affordance permanently inert (the relaunch stays armed from the first call).
    app.quit()
  }, Date.now())
}

/**
 * The latest release's page (the update modal's "View release", Settings→About's link).
 * Uses the cached URL from the last check, so no renderer-supplied URL is ever opened.
 *
 * R3: the caller shows this INSIDE Koloft — the global browser overlay — instead of
 * handing it to the system browser. Still whitelisted to http(s), because the value is a
 * GitHub API field and a `file:`/custom-scheme one must never reach a loader at all.
 * `KOLOFT_RELEASES_URL` is a test seam: a spec points the link at a local fixture rather
 * than at the live network.
 */
export function releasePageUrl(): string {
  const url = pending?.htmlUrl
  if (url && /^https?:\/\//i.test(url)) return url
  // no cached release (Settings→About link clicked before any check): the public
  // releases index is a constant, so the link never dead-ends
  return process.env.KOLOFT_RELEASES_URL || `https://github.com/${REPO}/releases`
}

/** Remove leftover koloft-update-* temp dirs from a prior failed/degraded attempt (best-effort).
 *  Bounds temp usage so repeated attempts don't pile up ~150MB dmgs. Safe: the single-flight
 *  `installing` guard means no other install of this session is using one, and a completed
 *  install relaunched us (its installer is gone). */
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
  } catch {
    /* best-effort — a leftover temp dir is harmless */
  }
}

/**
 * Download the newest dmg and install it over the running app, then relaunch. The app
 * is unsigned, so this is a DIY swap (Squirrel.Mac needs a signed bundle): a Node-fetched
 * file carries no com.apple.quarantine, so the replacement opens without Gatekeeper —
 * exactly what install.sh relies on. Resolves after spawning the detached installer (the
 * process then quits); throws a human-readable message on any failure so the modal can
 * surface it with nothing changed. Resolves with a 'restart-required' result — rather than
 * throwing — when the staged version turns out to be on disk already, so the modal can offer
 * the restart that actually resolves it instead of an error with no matching action.
 */
export async function downloadAndInstall(
  onProgress: (p: UpdateProgress) => void
): Promise<UpdateCheckResult | undefined> {
  if (!app.isPackaged) throw new Error('Updates can only be installed from the packaged app.')
  if (!pending) throw new Error('No update is staged — run a check first.')
  if (installing) throw new Error('An update is already in progress.')
  const bundle = appBundlePath()
  if (!bundle) throw new Error('Could not locate the running Koloft.app bundle.')

  // Latch BEFORE the first await: anything that yields between the check above and this line
  // lets a second download slip through, and two installers would race the bundle swap (each
  // sweeping the other's work dir and clobbering the ${DEST}.old rollback).
  installing = true
  // `work` holds the (~150MB) dmg + the staged app copy. The success path hands it to the
  // install script (which rm -rf's it) and the degradation path opens the dmg out of it —
  // both set keepWork; every other (failure) path cleans it in the catch.
  let work: string | null = null
  let keepWork = false
  try {
    // The modal can sit on an "available" result while the bundle is replaced by another
    // route; re-read the disk rather than re-downloading ~150MB to swap a version over
    // itself (which would also kill every pty and live session for nothing).
    const onDisk = await installedVersion()
    if (onDisk && !isNewer(pending.version, onDisk)) {
      installing = false // nothing was started, so don't hold the latch
      const running = app.getVersion()
      // Only a bundle NEWER than this process makes a restart worth anything; when disk and
      // process already agree the release is simply running, and prompting for a restart
      // would tear down every pty to relaunch into the identical version.
      return isNewer(onDisk, running)
        ? { status: 'restart-required', current: running, installed: onDisk }
        : { status: 'current', current: running, installed: onDisk }
    }
    await sweepStaleWorkDirs() // reap leftovers from any prior failed/degraded attempt
    work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'koloft-update-'))
    const dmgPath = path.join(work, `Koloft-${pending.version}.dmg`)
    await downloadTo(pending.dmgUrl, dmgPath, onProgress)
    // flip the modal to its "installing" state: when the server sends no Content-Length,
    // download progress stays at -1 and would never cross 100 on its own.
    onProgress({ percent: 100, transferred: 0, total: 0 })

    // If we can't replace the bundle in place (read-only install / not owned), degrade to
    // opening the dmg so the user can drag it — skip the mount/stage entirely, and never
    // half-quit into a missing app. shell.openPath resolves to a non-empty *error string*
    // (it doesn't reject) when the open fails, so check it before claiming we opened it.
    const canWrite = (await isWritable(bundle)) && (await isWritable(path.dirname(bundle)))
    if (!canWrite) {
      keepWork = true // the user needs the dmg we're opening in Finder — don't delete it
      // P0: through the one choke point, like every other hand-off to the OS. An
      // installer IS the user leaving Koloft for Finder — nothing changes but the fact that
      // the observation point (and any test) can now see it happen.
      const openErr = await leaveForOS(dmgPath, 'path')
      throw new Error(
        openErr
          ? `Koloft isn't writable at ${bundle}, and the installer couldn't be opened automatically. Download it from ${pending.htmlUrl || 'the releases page'} and drag Koloft into Applications.`
          : `Koloft isn't writable at ${bundle}. Opened the installer — drag Koloft into Applications, then reopen.`
      )
    }

    // mount the dmg, copy its .app to a staging dir, unmount — so nothing stays mounted
    // under a process that's about to exit. The bundle's name is read off the dmg, not
    // assumed.
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
    // Same name → swap the running bundle in place. New name → install beside it and have
    // the script remove the old bundle once the new one is complete (INSTALL_SCRIPT $5).
    const dest = path.join(path.dirname(bundle), path.basename(stagedApp))
    const oldBundle = dest === bundle ? '' : bundle

    const scriptPath = path.join(work, 'install.sh')
    await fs.promises.writeFile(scriptPath, INSTALL_SCRIPT, { mode: 0o755 })
    keepWork = true // handed to the install script, which rm -rf's $WORK after the swap
    // `work` is a `let` that outer error handling clears, so its narrowing does not reach
    // inside the callback below
    const workDir = work

    // file-edit B-26: the question comes BEFORE the spawn. The script waits only ~30s for
    // our PID (INSTALL_SCRIPT's `seq 1 150`), so a user who takes longer than that over the
    // unsaved-changes dialog would have had the bundle swapped underneath a running Koloft.
    // Nothing here is reversible once spawned, so nothing here happens unapproved.
    withApproval(
      () => {
        const child = spawn(
          '/bin/bash',
          [scriptPath, String(process.pid), stagedApp, dest, workDir, oldBundle],
          { detached: true, stdio: 'ignore' }
        )
        child.unref()
        // Let the detached child reach its kill -0 wait loop, then quit so it unblocks and
        // swaps. The child is in its own process group (detached), so our exit can't take
        // it down.
        setTimeout(() => app.quit(), 400)
      },
      Date.now(),
      () => {
        // cancelled: nothing was spawned, so release the single-flight latch or Install
        // would throw "already in progress" for the rest of the session. The staged dmg
        // stays put — the next attempt re-downloads into a fresh work dir.
        installing = false
      }
    )
    return undefined
  } catch (e) {
    installing = false // let the user retry; on success we never reach here (quitting)
    if (work && !keepWork) {
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {})
    }
    throw e
  }
}
