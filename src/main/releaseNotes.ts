import type { ReleaseNotes, WhatsNew } from '@shared/types'

export interface GhRelease {
  tag_name?: string
  body?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  assets?: { name: string; browser_download_url: string }[]
}

const INSTALL_MARKER = /<!--\s*koloft:install\s*-->/i
const LEGACY_INSTALL_BODY = /^\*\*未签名个人构建/
export const MAX_NOTES_RELEASES = 20

function parseVersion(v: string): number[] {
  const core = v.replace(/^v/, '').split(/[-+]/)[0]
  return core.split('.').map((n) => parseInt(n, 10) || 0)
}

export function cmpVersion(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export function isNewer(latest: string, current: string): boolean {
  return cmpVersion(latest, current) > 0
}

export function versionOf(rel: GhRelease): string {
  return (rel.tag_name || '').replace(/^v/, '')
}

export function isPublished(rel: GhRelease): boolean {
  return !rel.draft && !rel.prerelease && !!versionOf(rel)
}

export function sortReleases(list: GhRelease[]): GhRelease[] {
  return list.filter(isPublished).sort((a, b) => cmpVersion(versionOf(b), versionOf(a)))
}

export function changelogOf(body: string | undefined): string {
  const raw = (body || '').replace(/\r\n/g, '\n')
  const m = INSTALL_MARKER.exec(raw)
  const head = (m ? raw.slice(0, m.index) : raw).trim()
  if (!head) return ''
  if (!m && LEGACY_INSTALL_BODY.test(head)) return ''
  return head
}

export function notesSince(
  published: GhRelease[],
  basis: string
): { releases: ReleaseNotes[]; omittedReleases: number } {
  const all = published
    .filter((r) => isNewer(versionOf(r), basis))
    .map((r) => ({ version: versionOf(r), notes: changelogOf(r.body) }))
    .filter((r) => r.notes !== '')
  return {
    releases: all.slice(0, MAX_NOTES_RELEASES),
    omittedReleases: Math.max(0, all.length - MAX_NOTES_RELEASES)
  }
}

function notesBetween(
  published: GhRelease[],
  lastSeen: string,
  current: string
): { releases: ReleaseNotes[]; omittedReleases: number } {
  const currentOrOlder = published.filter((r) => !isNewer(versionOf(r), current))
  return notesSince(currentOrOlder, lastSeen)
}

export async function whatsNewDecision(
  lastSeen: string,
  current: string,
  fetchFeed: () => Promise<GhRelease[]>
): Promise<{ show: WhatsNew | null; record: string | null }> {
  if (lastSeen === '') return { show: null, record: current }
  if (lastSeen === current) return { show: null, record: null }
  let published: GhRelease[]
  try {
    published = await fetchFeed()
  } catch {
    return { show: null, record: null }
  }
  const { releases, omittedReleases } = notesBetween(published, lastSeen, current)
  if (releases.length === 0) return { show: null, record: current }
  return { show: { current, releases, omittedReleases }, record: null }
}
