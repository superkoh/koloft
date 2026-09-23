import fs from 'fs'
import path from 'path'
import type { E2EEnv } from './env'

// The update check's metadata seam: KOLOFT_UPDATE_FIXTURE points at a JSON file shaped
// like GitHub's /releases reply. Versions are always derived from the launched app's own
// `app.getVersion()` — an unpackaged run reports ELECTRON's version, never package.json's.

/** Parse the leading major.minor.patch out of a version string (ignores any
 *  build/prerelease suffix app.getVersion() might carry). */
export function parseVer(v: string): [number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) throw new Error(`cannot parse version: ${v}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** A version strictly greater than `base` (patch-bump by `n`, default 1). */
export function higher(base: string, n = 1): string {
  const [maj, min, pat] = parseVer(base)
  return `${maj}.${min}.${pat + n}`
}

/** A version strictly lower than `base`, without going negative. */
export function lower(base: string): string {
  const [maj, min, pat] = parseVer(base)
  if (pat > 0) return `${maj}.${min}.${pat - 1}`
  if (min > 0) return `${maj}.${min - 1}.99`
  if (maj > 0) return `${maj - 1}.99.99`
  return '0.0.0'
}

/** The install-instructions half every real release body carries, in the shape
 *  scripts/release-notes.sh emits: both commands fenced, and a first non-empty line
 *  starting with the exact text the legacy-body rule keys off. */
export const INSTALL_TEXT =
  '**未签名个人构建**,需要手动允许运行:\n\n' +
  '```bash\n' +
  'curl -fsSL https://raw.githubusercontent.com/superkoh/koloft-releases/main/install.sh | bash\n' +
  '```\n\n' +
  'Or:\n\n' +
  '```bash\n' +
  'xattr -dr com.apple.quarantine /Applications/Koloft.app\n' +
  '```\n'

/** New-format body: a changelog section, the install-cutoff marker, then the install
 *  text — only the part before the marker should ever reach the DOM. */
export function notesBody(changelogMd: string): string {
  return `${changelogMd}\n\n<!-- koloft:install -->\n${INSTALL_TEXT}`
}

/** A `## What's Changed` section with the given bullet lines. */
export function changelog(...items: string[]): string {
  return ["## What's Changed", '', ...items.map((i) => `- ${i}`)].join('\n')
}

export interface FixtureRelease {
  tag_name: string
  name: string
  body: string
  html_url: string
  draft: boolean
  prerelease: boolean
  assets: { name: string; browser_download_url: string }[]
}

/** Build one GitHub-release-shaped fixture entry (the GitHub /releases JSON shape). */
export function release(
  version: string,
  body: string,
  opts: { draft?: boolean; prerelease?: boolean } = {}
): FixtureRelease {
  return {
    tag_name: `v${version}`,
    name: `Koloft v${version}`,
    body,
    html_url: `https://github.com/superkoh/koloft-releases/releases/tag/v${version}`,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    assets: [
      {
        name: `Koloft-${version}-arm64.dmg`,
        browser_download_url: `https://example.invalid/Koloft-${version}-arm64.dmg`
      }
    ]
  }
}

export function writeFixture(file: string, releases: FixtureRelease[]): void {
  fs.writeFileSync(file, JSON.stringify(releases, null, 2))
}

/**
 * Point KOLOFT_UPDATE_FIXTURE at a file under the isolated $HOME, pre-seeded with an empty
 * array so any check that races ahead of a test's real write sees "no releases" rather
 * than a missing/invalid file. Must be called BEFORE launchApp -- env vars are fixed at
 * process launch -- but the file's CONTENT can still be rewritten after launch (the
 * check reads it at check-time, not at launch time), which lets a spec compute fixture
 * versions relative to the just-launched app's own running version.
 */
export function withFixtureEnv(env: E2EEnv): string {
  const file = path.join(env.home, 'update-fixture.json')
  fs.writeFileSync(file, '[]')
  env.launchEnv.KOLOFT_UPDATE_FIXTURE = file
  return file
}
