import { describe, it, expect } from 'vitest'
import {
  MAX_NOTES_RELEASES,
  changelogOf,
  cmpVersion,
  isNewer,
  notesSince,
  sortReleases,
  whatsNewDecision,
  type GhRelease
} from '../../src/main/releaseNotes'

const INSTALL = `<!-- koloft:install -->
**未签名个人构建 (macOS arm64, unsigned).** 最省事的装法 —— curl 下载不会被打上
quarantine,装完双击即开,无需任何 Gatekeeper 操作:

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/superkoh/koloft-releases/main/install.sh | bash
\`\`\``

const LEGACY_BODY = INSTALL.replace('<!-- koloft:install -->\n', '')

function rel(tag: string, body = `## What's Changed\n\n- feat: ${tag}\n\n${INSTALL}`): GhRelease {
  return {
    tag_name: tag,
    body,
    assets: [
      { name: `Koloft-${tag.replace(/^v/, '')}-arm64.dmg`, browser_download_url: 'https://x/y' }
    ]
  }
}

describe('changelogOf', () => {
  it('keeps only what precedes the install marker', () => {
    const notes = changelogOf(`## What's Changed\n\n- feat: a\n- fix: b\n\n${INSTALL}`)
    expect(notes).toBe("## What's Changed\n\n- feat: a\n- fix: b")
    expect(notes).not.toMatch(/curl|xattr|未签名/)
  })

  it('treats the legacy install-only body as no changelog at all: the app installs itself, so install steps are noise', () => {
    expect(changelogOf(LEGACY_BODY)).toBe('')
  })

  it('reports nothing for an empty body, a whitespace body, or a leading marker', () => {
    expect(changelogOf('')).toBe('')
    expect(changelogOf(undefined)).toBe('')
    expect(changelogOf('   \n\n ')).toBe('')
    expect(changelogOf(INSTALL)).toBe('')
  })

  it('tolerates marker whitespace/case and CRLF bodies', () => {
    expect(changelogOf('- fix: a\r\n\r\n<!--   Koloft:Install   -->\r\ninstall stuff')).toBe(
      '- fix: a'
    )
  })

  it('keeps a marker-less body that has real content', () => {
    expect(changelogOf('- fix: hand-written note')).toBe('- fix: hand-written note')
  })
})

describe('cmpVersion / isNewer', () => {
  it('orders numerically, not lexically', () => {
    expect(cmpVersion('0.10.0', '0.9.0')).toBe(1)
    expect(isNewer('0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('0.9.0', '0.10.0')).toBe(false)
  })

  it('ignores the v prefix and prerelease/build suffixes, and equal is not newer', () => {
    expect(cmpVersion('v1.2.3', '1.2.3')).toBe(0)
    expect(cmpVersion('1.2.3-beta.1', '1.2.3')).toBe(0)
    expect(isNewer('1.2.3', '1.2.3')).toBe(false)
  })
})

describe('sortReleases', () => {
  it('sorts newest first and drops drafts, prereleases and untagged entries', () => {
    const list: GhRelease[] = [
      rel('v0.5.0'),
      { ...rel('v0.9.0'), draft: true },
      { ...rel('v0.8.0'), prerelease: true },
      rel('v0.6.0'),
      { body: 'no tag' }
    ]
    expect(sortReleases(list).map((r) => r.tag_name)).toEqual(['v0.6.0', 'v0.5.0'])
  })
})

describe('notesSince', () => {
  const published = sortReleases([rel('v0.5.1'), rel('v0.5.2'), rel('v0.6.0'), rel('v0.5.0')])

  it('spans every release newer than the installed version, newest first', () => {
    const { releases, omittedReleases } = notesSince(published, '0.5.0')
    expect(releases.map((r) => r.version)).toEqual(['0.6.0', '0.5.2', '0.5.1'])
    expect(releases[0].notes).toContain('- feat: v0.6.0')
    expect(omittedReleases).toBe(0)
  })

  it('excludes the installed version itself and anything older', () => {
    expect(notesSince(published, '0.5.2').releases.map((r) => r.version)).toEqual(['0.6.0'])
  })

  it('leaves out releases whose body carries no changelog', () => {
    const mixed = sortReleases([rel('v0.7.0'), rel('v0.6.0', LEGACY_BODY), rel('v0.5.5', '')])
    expect(notesSince(mixed, '0.5.0').releases.map((r) => r.version)).toEqual(['0.7.0'])
  })

  it('reports nothing at all when no release in the span published a changelog', () => {
    const legacy = sortReleases([rel('v0.5.1', LEGACY_BODY), rel('v0.5.2', LEGACY_BODY)])
    expect(notesSince(legacy, '0.5.0').releases).toEqual([])
  })

  it('caps the list and counts the remainder instead of truncating silently', () => {
    const many = sortReleases(
      Array.from({ length: MAX_NOTES_RELEASES + 5 }, (_, i) => rel(`v1.0.${i + 1}`))
    )
    const { releases, omittedReleases } = notesSince(many, '1.0.0')
    expect(releases).toHaveLength(MAX_NOTES_RELEASES)
    expect(releases[0].version).toBe(`1.0.${MAX_NOTES_RELEASES + 5}`)
    expect(omittedReleases).toBe(5)
  })
})

describe('U-OB-02: whatsNewDecision picks the span to show and, separately, the version to remember', () => {
  const published = sortReleases([rel('v0.22.0'), rel('v0.21.3'), rel('v0.21.2'), rel('v0.21.0')])
  const feed = () => Promise.resolve(published)
  const noFeed = (): Promise<GhRelease[]> => Promise.reject(new Error('offline'))

  it('shows the span above lastSeen and at or below the running version, recording nothing until the dismiss', async () => {
    const { show, record } = await whatsNewDecision('0.21.0', '0.21.3', feed)
    expect(show?.current).toBe('0.21.3')
    expect(show?.releases.map((r) => r.version)).toEqual(['0.21.3', '0.21.2'])
    expect(show?.omittedReleases).toBe(0)
    expect(record).toBeNull()
  })

  it('says nothing and records the version on a first install', async () => {
    expect(await whatsNewDecision('', '0.21.3', noFeed)).toEqual({ show: null, record: '0.21.3' })
  })

  it('says nothing and records nothing when the user already ran this version', async () => {
    expect(await whatsNewDecision('0.21.3', '0.21.3', noFeed)).toEqual({
      show: null,
      record: null
    })
  })

  it('records nothing when the feed cannot be read, so the next launch retries', async () => {
    expect(await whatsNewDecision('0.21.0', '0.21.3', noFeed)).toEqual({
      show: null,
      record: null
    })
  })

  it('records the version when the span has no changelog in it at all', async () => {
    const mixed = sortReleases([rel('v0.21.3', LEGACY_BODY), rel('v0.21.2', LEGACY_BODY)])
    expect(await whatsNewDecision('0.21.0', '0.21.3', () => Promise.resolve(mixed))).toEqual({
      show: null,
      record: '0.21.3'
    })
  })

  it('still drops a release with no changelog of its own', async () => {
    const mixed = sortReleases([rel('v0.21.3'), rel('v0.21.2', LEGACY_BODY)])
    const { show } = await whatsNewDecision('0.21.0', '0.21.3', () => Promise.resolve(mixed))
    expect(show?.releases.map((r) => r.version)).toEqual(['0.21.3'])
  })
})
