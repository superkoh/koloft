import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const script = path.resolve(__dirname, '../../scripts/site-changelog.mjs')
const INSTALL = '<!-- koloft:install -->\n**The build is unsigned.**\n- not a change line'

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function run(page: string, releases: unknown): { status: number | null; page: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-changelog-'))
  createdDirs.push(dir)
  const pageFile = path.join(dir, 'index.html')
  const releasesFile = path.join(dir, 'releases.json')
  fs.writeFileSync(pageFile, page)
  fs.writeFileSync(releasesFile, JSON.stringify(releases))
  const result = spawnSync(process.execPath, [script, releasesFile, pageFile])
  return { status: result.status, page: fs.readFileSync(pageFile, 'utf8') }
}

const release = (tag: string, published: string, lines: string[]) => ({
  tag_name: tag,
  published_at: published,
  body: `## What's Changed\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\n${INSTALL}`
})

describe('site-changelog.mjs', () => {
  it('lists releases newest first: feat under new, fix under fixed, every other line under also, the install block left out, the text shown as written', () => {
    const { status, page } = run('<main><!-- releases --></main>', [
      [
        release('v1.0.0', '2026-01-01T00:00:00Z', ['feat(cron): an old feature (#1)']),
        release('v1.1.0', '2026-02-03T00:00:00Z', [
          'feat(agent): koloft session close <id or name> (#20)',
          'fix(remote): a fix for issue #9 (#21)',
          'build: strip paths',
          'Koloft is open source: "https://github.com/superkoh/koloft" costs $$ nothing $&'
        ])
      ]
    ])
    expect(status).toBe(0)
    expect(page.indexOf('v1.1.0')).toBeLessThan(page.indexOf('v1.0.0'))
    const newer = page.slice(page.indexOf('v1.1.0'), page.indexOf('v1.0.0'))
    expect(newer).toContain('3 Feb 2026')
    expect(newer).toMatch(/<h3>new<\/h3>[\s\S]*koloft session close &lt;id or name&gt;/)
    expect(newer).toContain('href="https://github.com/superkoh/koloft/issues/20">#20</a>')
    expect(newer).toMatch(/<h3>fixed<\/h3>[\s\S]*issue <a href="[^"]*\/issues\/9">#9<\/a>/)
    expect(newer).toMatch(/<h3>also<\/h3>[\s\S]*build: strip paths/)
    expect(newer).toContain(
      '&quot;<a href="https://github.com/superkoh/koloft">https://github.com/superkoh/koloft</a>&quot; costs $$ nothing $&amp;'
    )
    expect(page).not.toContain('unsigned')
    expect(page).not.toContain('not a change line')
  })

  it('fails instead of publishing an empty changelog', () => {
    expect(run('<main></main>', [[release('v1.0.0', '2026-01-01T00:00:00Z', [])]]).status).not.toBe(
      0
    )
    expect(run('<main><!-- releases --></main>', [[]]).status).not.toBe(0)
  })
})
