import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync, execFileSync, type SpawnSyncReturns } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const repoRoot = path.resolve(__dirname, '../..')
const script = path.join(repoRoot, 'scripts/release-notes.sh')
const MARKER = '<!-- koloft:install -->'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function freshRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-relnotes-')))
  createdDirs.push(dir)
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', dir], { env: GIT_ENV })
  return dir
}

function plainDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-relnotes-plain-')))
  createdDirs.push(dir)
  return dir
}

function commit(dir: string, subject: string): void {
  execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', subject], { env: GIT_ENV })
}

function tag(dir: string, name: string): void {
  execFileSync('git', ['-C', dir, 'tag', name], { env: GIT_ENV })
}

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { env: GIT_ENV })
}

function run(dir: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync('bash', [script, ...args], { cwd: dir, encoding: 'utf8', env: GIT_ENV })
}

function fencedBlocks(text: string): string[] {
  const out: string[] = []
  const re = /```[^\n]*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m[1])
  return out
}

function beforeMarker(stdout: string): string {
  const idx = stdout.indexOf(MARKER)
  return idx === -1 ? stdout : stdout.slice(0, idx)
}

describe('scripts/release-notes.sh — CLI contract', () => {
  it("A1: lists non-merge commit subjects newest-first under one ## What's Changed heading", () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')
    tag(dir, 'v0.1.0')
    commit(dir, 'feat: alpha (#1)')
    commit(dir, 'fix: beta (#2)')
    commit(dir, 'docs: gamma')

    const { stdout, status } = run(dir, '0.2.0', 'v0.1.0')

    expect(status).toBe(0)
    expect(stdout).toContain("## What's Changed")
    expect(stdout).toContain('- feat: alpha (#1)')
    expect(stdout).toContain('- fix: beta (#2)')
    expect(stdout).toContain('- docs: gamma')
    const iAlpha = stdout.indexOf('- feat: alpha (#1)')
    const iBeta = stdout.indexOf('- fix: beta (#2)')
    const iGamma = stdout.indexOf('- docs: gamma')
    expect(iGamma).toBeLessThan(iBeta)
    expect(iBeta).toBeLessThan(iAlpha)
  })

  it('A2: drops "chore: release …" and "chore(release)…" commits from the list', () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')
    tag(dir, 'v0.1.0')
    commit(dir, 'feat: x (#1)')
    commit(dir, 'chore: release v0.2.0')
    commit(dir, 'chore(release): v0.2.0')
    commit(dir, 'fix: y (#2)')

    const { stdout } = run(dir, '0.2.0', 'v0.1.0')

    expect(stdout).toContain('- feat: x (#1)')
    expect(stdout).toContain('- fix: y (#2)')
    expect(stdout).not.toContain('chore: release v0.2.0')
    expect(stdout).not.toContain('chore(release): v0.2.0')
  })

  it("A3: drops merge commit subjects while keeping the branch's real commits", () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')
    tag(dir, 'v0.1.0')
    git(dir, ['checkout', '-q', '-b', 'feature'])
    commit(dir, 'feat: on branch (#5)')
    git(dir, ['checkout', '-q', 'main'])
    commit(dir, 'fix: on main (#6)')
    git(dir, ['merge', '--no-ff', '-m', "Merge branch 'feature'", 'feature'])

    const { stdout } = run(dir, '0.2.0', 'v0.1.0')

    expect(stdout).toContain('- feat: on branch (#5)')
    expect(stdout).toContain('- fix: on main (#6)')
    expect(stdout).not.toContain('Merge branch')
  })

  it('A4: no commits in range omits the heading entirely (no empty list) but still exits 0', () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')
    tag(dir, 'v0.1.0')

    const { stdout, status } = run(dir, '0.2.0', 'v0.1.0')

    expect(status).toBe(0)
    expect(stdout).not.toContain("## What's Changed")
    expect(stdout).toContain(MARKER)
  })

  it('A5: the install marker appears exactly once, after the changelog heading', () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')
    tag(dir, 'v0.1.0')
    commit(dir, 'feat: only (#1)')

    const { stdout } = run(dir, '0.2.0', 'v0.1.0')

    const occurrences = stdout.split(MARKER).length - 1
    expect(occurrences).toBe(1)
    const headingIdx = stdout.indexOf("## What's Changed")
    expect(headingIdx).toBeGreaterThan(-1)
    expect(headingIdx).toBeLessThan(stdout.indexOf(MARKER))
  })

  it('A6: install instructions are preserved verbatim, each inside a ``` fence, for GitHub web visitors the modal cut does not reach', () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')

    const { stdout } = run(dir, '0.1.0')
    const installPart = stdout.slice(stdout.indexOf(MARKER))
    const blocks = fencedBlocks(installPart)

    expect(
      blocks.some((b) =>
        b.includes(
          'curl -fsSL https://raw.githubusercontent.com/superkoh/koloft-releases/main/install.sh | bash'
        )
      )
    ).toBe(true)
    expect(
      blocks.some((b) => b.includes('xattr -dr com.apple.quarantine /Applications/Koloft.app'))
    ).toBe(true)
    expect(installPart).toContain('unsigned')
  })

  it('A7: notes differ across versions instead of being byte-identical, and each run lists its own non-empty range of commits', () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')
    tag(dir, 'v0.1.0')
    commit(dir, 'feat: b (#1)')

    const run1 = run(dir, '0.2.0', 'v0.1.0')
    expect(run1.stdout).toContain('- feat: b (#1)')

    tag(dir, 'v0.2.0')
    commit(dir, 'feat: c (#2)')
    commit(dir, 'fix: d (#3)')
    tag(dir, 'v0.3.0')
    const run2 = run(dir, '0.3.0', 'v0.2.0')

    expect(beforeMarker(run1.stdout)).not.toBe(beforeMarker(run2.stdout))
    expect(run2.stdout).toContain('- feat: c (#2)')
    expect(run2.stdout).toContain('- fix: d (#3)')
    expect(run2.stdout).not.toContain('feat: b (#1)')
  })

  it('A8: prev-tag defaults to the highest v* tag strictly below <version>', () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')
    tag(dir, 'v0.1.0')
    commit(dir, 'feat: a (#1)')
    tag(dir, 'v0.2.0')
    commit(dir, 'feat: b (#2)')

    const { stdout, status } = run(dir, '0.3.0')

    expect(status).toBe(0)
    expect(stdout).toContain('- feat: b (#2)')
    expect(stdout).not.toContain('feat: a (#1)')
    expect(stdout).not.toContain('chore: init')
  })

  it('A9: an already-existing end tag is used as the range end, not HEAD', () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')
    tag(dir, 'v0.1.0')
    commit(dir, 'feat: in-version (#1)')
    tag(dir, 'v0.3.0')
    commit(dir, 'feat: not-in-version (#2)')

    const { stdout, status } = run(dir, '0.3.0', 'v0.1.0')

    expect(status).toBe(0)
    expect(stdout).toContain('- feat: in-version (#1)')
    expect(stdout).not.toContain('feat: not-in-version (#2)')
  })

  it('A10: a tagless repo (first-ever release) still succeeds and lists all commits', () => {
    const dir = freshRepo()
    commit(dir, 'feat: first (#1)')
    commit(dir, 'fix: second (#2)')

    const { stdout, status } = run(dir, '0.1.0')

    expect(status).toBe(0)
    expect(stdout).toContain('- feat: first (#1)')
    expect(stdout).toContain('- fix: second (#2)')
  })

  it('A11a: a non-git directory fails loudly instead of emitting half a notes doc', () => {
    const dir = plainDir()

    const { stdout, stderr, status } = run(dir, '0.1.0')

    expect(status).not.toBe(0)
    expect(stderr.length).toBeGreaterThan(0)
    expect(stdout).not.toContain("## What's Changed")
    expect(stdout).not.toContain(MARKER)
  })

  it('A11b: a missing <version> argument fails with a non-zero exit code', () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')

    const { status } = run(dir)

    expect(status).not.toBe(0)
  })

  it('A12: commit subjects with backticks/$()/${} pass through unevaluated', () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')
    tag(dir, 'v0.1.0')
    const subject = 'fix: `whoami` and $(id) and ${HOME}'
    commit(dir, subject)

    const { stdout } = run(dir, '0.2.0', 'v0.1.0')

    expect(stdout).toContain(`- ${subject}`)
    expect(stdout).not.toMatch(/uid=\d+/)
    expect(stdout).not.toContain(os.homedir())
  })
})
