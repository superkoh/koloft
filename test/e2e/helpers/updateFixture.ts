import fs from 'fs'
import path from 'path'
import type { E2EEnv } from './env'

// PLATFORM§4
export function parseVer(v: string): [number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) throw new Error(`cannot parse version: ${v}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export function higher(base: string, n = 1): string {
  const [maj, min, pat] = parseVer(base)
  return `${maj}.${min}.${pat + n}`
}

export function lower(base: string): string {
  const [maj, min, pat] = parseVer(base)
  if (pat > 0) return `${maj}.${min}.${pat - 1}`
  if (min > 0) return `${maj}.${min - 1}.99`
  if (maj > 0) return `${maj - 1}.99.99`
  return '0.0.0'
}

export const INSTALL_TEXT =
  '**未签名个人构建**,需要手动允许运行:\n\n' +
  '```bash\n' +
  'curl -fsSL https://raw.githubusercontent.com/superkoh/koloft-releases/main/install.sh | bash\n' +
  '```\n\n' +
  'Or:\n\n' +
  '```bash\n' +
  'xattr -dr com.apple.quarantine /Applications/Koloft.app\n' +
  '```\n'

export function notesBody(changelogMd: string): string {
  return `${changelogMd}\n\n<!-- koloft:install -->\n${INSTALL_TEXT}`
}

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

export function withFixtureEnv(env: E2EEnv): string {
  const file = path.join(env.home, 'update-fixture.json')
  fs.writeFileSync(file, '[]')
  env.launchEnv.KOLOFT_UPDATE_FIXTURE = file
  return file
}
