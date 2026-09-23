/**
 * Turning the public repo's GitHub releases into what the update modal shows: which release
 * is the newest installable one, and the changelog for every release the user skipped.
 *
 * Kept free of `electron` imports (updater.ts owns the network + install side) so this —
 * the part with all the parsing judgement in it — is directly unit-testable.
 */

import type { ReleaseNotes, WhatsNew } from '@shared/types'

/** The subset of the GitHub release JSON this app reads. */
export interface GhRelease {
  tag_name?: string
  body?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  assets?: { name: string; browser_download_url: string }[]
}

// Everything from this marker down is install instructions written for GitHub web visitors
// (see scripts/release-notes.sh). The modal's reader is mid-self-update — the app downloads,
// swaps and relaunches itself — so those steps are noise there, and only the changelog above
// the marker is shown.
const INSTALL_MARKER = /<!--\s*koloft:install\s*-->/i
// Some older releases carried notes that were ONLY install text: no marker, no changelog.
// Recognize that body so those releases contribute nothing, instead of presenting install
// steps as if they were a changelog.
const LEGACY_INSTALL_BODY = /^\*\*未签名个人构建/
/** A long-stale install shouldn't render dozens of changelog sections. The remainder is
 *  counted and reported, never silently dropped. */
export const MAX_NOTES_RELEASES = 20

/** Bare-semver parse ("v" prefix and any -prerelease/+build suffix stripped). */
function parseVersion(v: string): number[] {
  const core = v.replace(/^v/, '').split(/[-+]/)[0]
  return core.split('.').map((n) => parseInt(n, 10) || 0)
}

/** -1 / 0 / 1. One ordering for both jobs — deciding whether an update exists and sorting
 *  the release list — because two notions of "newest" that disagreed would show a changelog
 *  belonging to a version other than the one being offered. */
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

/** Only real releases are offered or listed. The list endpoint hands back drafts (when
 *  authenticated) and prereleases, which /releases/latest used to filter for us — treating
 *  either as newest would push an unfinished build at every user. */
export function isPublished(rel: GhRelease): boolean {
  return !rel.draft && !rel.prerelease && !!versionOf(rel)
}

/** Published releases, newest first. */
export function sortReleases(list: GhRelease[]): GhRelease[] {
  return list.filter(isPublished).sort((a, b) => cmpVersion(versionOf(b), versionOf(a)))
}

/** The changelog half of a release body: everything above the install marker, trimmed.
 *  Empty when there is nothing to show — an empty body, a marker with nothing before it, or
 *  a marker-less legacy body that is only install instructions. */
export function changelogOf(body: string | undefined): string {
  const raw = (body || '').replace(/\r\n/g, '\n')
  const m = INSTALL_MARKER.exec(raw)
  const head = (m ? raw.slice(0, m.index) : raw).trim()
  if (!head) return ''
  if (!m && LEGACY_INSTALL_BODY.test(head)) return ''
  return head
}

/** Changelogs for every published release newer than `basis`, newest first. A release with
 *  no changelog drops out rather than rendering a heading with nothing under it. */
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

/** "What's new": the changelogs for `(lastSeen, current]`. Same list `notesSince`
 *  builds, minus anything newer than the running app — a nightly or a release cut while
 *  this build was installed would otherwise be presented as "what's new in Koloft
 *  <current>", which it is not. */
function notesBetween(
  published: GhRelease[],
  lastSeen: string,
  current: string
): { releases: ReleaseNotes[]; omittedReleases: number } {
  const currentOrOlder = published.filter((r) => !isNewer(versionOf(r), current))
  return notesSince(currentOrOlder, lastSeen)
}

/**
 * "What's new": what one launch does about `settings.lastSeenVersion`.
 *  - `show` is the modal's content, null when there is nothing worth a modal.
 *  - `record` is the version to write, null when nothing should be written: a feed this
 *    launch could not read must be retried next time rather than burn this upgrade's one
 *    showing, and a span that DOES have notes is only recorded once the user dismisses them.
 * The feed is asked for only when the span could hold something, so the common
 * "same version again" launch makes no request at all.
 */
export async function whatsNewDecision(
  lastSeen: string,
  current: string,
  fetchFeed: () => Promise<GhRelease[]>
): Promise<{ show: WhatsNew | null; record: string | null }> {
  // a first install has nothing to have missed; recording now is what makes the NEXT
  // upgrade span the right range
  if (lastSeen === '') return { show: null, record: current }
  if (lastSeen === current) return { show: null, record: null }
  let published: GhRelease[]
  try {
    published = await fetchFeed()
  } catch {
    return { show: null, record: null }
  }
  const { releases, omittedReleases } = notesBetween(published, lastSeen, current)
  // an upgrade whose releases published no changelog counts as read — otherwise every
  // launch from here on re-fetches the feed to learn the same nothing
  if (releases.length === 0) return { show: null, record: current }
  return { show: { current, releases, omittedReleases }, record: null }
}
