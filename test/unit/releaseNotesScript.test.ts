import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync, execFileSync, type SpawnSyncReturns } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// scripts/release-notes.sh is the fix for the bug where every release from v0.3.2 to
// an earlier release shipped byte-identical notes (install instructions only, no changelog): the
// release flow never generated one. These are pure black-box CLI tests — argv in,
// stdout/stderr/exit code out — written against the feature's requirements without
// reading the script, so a failure here is a real regression rather than a test that was
// bent to match the code.
//
// The CLI contract each case below pins:
//  1. `release-notes.sh <version> [baseline-tag]`, run inside the target repo. Notes to
//     stdout, diagnostics to stderr.
//  2. Range end = tag `v<version>` when it exists, else HEAD. Baseline defaults to the
//     highest `v*` tag strictly below <version>; with no earlier tag, all of history.
//  3. One `- <subject>` line per non-merge commit in range, newest first, with
//     `chore: release …` / `chore(release)…` subjects dropped.
//  4. Exactly one `## What's Changed` heading when there are entries, none when there are
//     none; exactly one `<!-- koloft:install -->` marker, always after the changelog.
//  5. Below the marker: the install instructions, each command inside a ``` fence.
//  6. Exit non-zero on a missing <version> or a non-git directory — and no partial notes
//     on stdout, so a broken run can never be published as changelog-free notes.
//  7. Commit subjects are never evaluated: backticks, $(…) and ${…} pass through verbatim.

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

/** A fresh, initialized (but commit-less) git repo in its own temp dir. */
function freshRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-relnotes-')))
  createdDirs.push(dir)
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', dir], { env: GIT_ENV })
  return dir
}

/** A plain temp dir that is deliberately NOT a git repo. */
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

/** Extract all ```…``` fenced blocks' inner content, in order. */
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

    // Regression this pins: the changelog section going missing entirely, or the
    // list rendering oldest-first instead of newest-first.
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

    // Regression this pins: every version's changelog leading with its own, useless
    // release commit because the filter never fired.
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

    // Regression this pins: "Merge branch …" noise flooding the changelog.
    expect(stdout).toContain('- feat: on branch (#5)')
    expect(stdout).toContain('- fix: on main (#6)')
    expect(stdout).not.toContain('Merge branch')
  })

  it('A4: no commits in range omits the heading entirely (no empty list) but still exits 0', () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')
    tag(dir, 'v0.1.0')
    // no further commits: v0.1.0..HEAD is empty

    const { stdout, status } = run(dir, '0.2.0', 'v0.1.0')

    // Regression this pins: emitting a bare "## What's Changed" heading with nothing
    // under it, which the modal would render as an empty changelog box.
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

    // Regression this pins: a missing/duplicated marker (modal would show install
    // steps, or show them twice), or a marker placed before the changelog (modal
    // would render nothing at all since it only keeps the pre-marker half).
    const occurrences = stdout.split(MARKER).length - 1
    expect(occurrences).toBe(1)
    const headingIdx = stdout.indexOf("## What's Changed")
    expect(headingIdx).toBeGreaterThan(-1)
    expect(headingIdx).toBeLessThan(stdout.indexOf(MARKER))
  })

  it('A6: install instructions are preserved verbatim, each inside a ``` fence', () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')

    const { stdout } = run(dir, '0.1.0')
    const installPart = stdout.slice(stdout.indexOf(MARKER))
    const blocks = fencedBlocks(installPart)

    // Regression this pins: a refactor losing the install text, which is still the
    // guidance GitHub web visitors rely on (the modal cuts it, GitHub doesn't).
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

  it('A7: notes differ across versions instead of being byte-identical (the bug itself)', () => {
    // Recipe v2 (revised after this suite's first pass): commit A -> tag
    // v0.1.0 -> commit B -> run 0.2.0/v0.1.0; then tag v0.2.0 -> commits C, D -> tag
    // v0.3.0 -> run 0.3.0/v0.2.0. v1 tagged v0.2.0 right at HEAD with no commits after,
    // so the second run's own range (v0.2.0..HEAD) was empty and "doesn't contain B"
    // was satisfied vacuously — it never actually checked that run 2 lists its own
    // commits. Tagging v0.3.0 after C and D makes that range non-empty.
    const dir = freshRepo()
    commit(dir, 'chore: init') // commit A
    tag(dir, 'v0.1.0')
    commit(dir, 'feat: b (#1)') // commit B

    const run1 = run(dir, '0.2.0', 'v0.1.0')
    expect(run1.stdout).toContain('- feat: b (#1)')

    tag(dir, 'v0.2.0')
    commit(dir, 'feat: c (#2)') // commit C
    commit(dir, 'fix: d (#3)') // commit D
    tag(dir, 'v0.3.0')
    const run2 = run(dir, '0.3.0', 'v0.2.0')

    // Regression this pins: this is the exact incident — v0.3.2..v0.5.2 all produced
    // the same notes regardless of git state. Each run's changelog half must differ,
    // and each version's notes must list its own commits (C, D) and nothing from the
    // version before it (B).
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

    const { stdout, status } = run(dir, '0.3.0') // no prev-tag argument

    // Regression this pins: defaulting to the wrong baseline (e.g. earliest tag or no
    // tag) and re-listing an older version's already-published commits every time.
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
    commit(dir, 'feat: not-in-version (#2)') // committed AFTER the v0.3.0 tag

    const { stdout, status } = run(dir, '0.3.0', 'v0.1.0')

    // Regression this pins: using HEAD as the range end even when v0.3.0 already
    // exists, leaking the next version's not-yet-released commit into this version's
    // notes.
    expect(status).toBe(0)
    expect(stdout).toContain('- feat: in-version (#1)')
    expect(stdout).not.toContain('feat: not-in-version (#2)')
  })

  it('A10: a tagless repo (first-ever release) still succeeds and lists all commits', () => {
    const dir = freshRepo()
    commit(dir, 'feat: first (#1)')
    commit(dir, 'fix: second (#2)')

    const { stdout, status } = run(dir, '0.1.0') // no tags exist at all

    // Regression this pins: a `git describe`-style baseline lookup erroring out in a
    // tagless repo, which would break the very first release.
    expect(status).toBe(0)
    expect(stdout).toContain('- feat: first (#1)')
    expect(stdout).toContain('- fix: second (#2)')
  })

  it('A11a: a non-git directory fails loudly instead of emitting half a notes doc', () => {
    const dir = plainDir()

    const { stdout, stderr, status } = run(dir, '0.1.0')

    // Regression this pins: silently producing changelog-free notes outside a repo,
    // which is exactly how the original bug could ship again unnoticed.
    expect(status).not.toBe(0)
    expect(stderr.length).toBeGreaterThan(0)
    expect(stdout).not.toContain("## What's Changed")
    expect(stdout).not.toContain(MARKER)
  })

  it('A11b: a missing <version> argument fails with a non-zero exit code', () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')

    const { status } = run(dir) // no version arg at all

    expect(status).not.toBe(0)
  })

  it('A12: commit subjects with backticks/$()/${} pass through unevaluated', () => {
    const dir = freshRepo()
    commit(dir, 'chore: init')
    tag(dir, 'v0.1.0')
    const subject = 'fix: `whoami` and $(id) and ${HOME}'
    commit(dir, subject)

    const { stdout } = run(dir, '0.2.0', 'v0.1.0')

    // Regression this pins: the script shelling out the subject via echo/eval, which
    // would turn this into a command-injection vector and/or garble the notes with
    // whatever the substitutions happened to evaluate to.
    expect(stdout).toContain(`- ${subject}`)
    expect(stdout).not.toMatch(/uid=\d+/) // real `id` output would look like this
    expect(stdout).not.toContain(os.homedir()) // real ${HOME} expansion
  })
})
