import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  acceptClaudeTrust,
  claudeTrustsFolder,
  isTrustedByClaude,
  markClaudeOnboarded
} from '../../src/main/claudeTrust'

const doc =
  (projects: Record<string, unknown>): (() => unknown) =>
  () => ({ projects })

// CC§9
describe('isTrustedByClaude', () => {
  it('says yes for the folder itself', () => {
    const read = doc({ '/Users/me/repo': { hasTrustDialogAccepted: true } })
    expect(isTrustedByClaude(read, '/Users/me/repo', null)).toBe(true)
  })

  it('says yes when an ancestor was trusted', () => {
    const read = doc({ '/Users/me/repo': { hasTrustDialogAccepted: true } })
    expect(isTrustedByClaude(read, '/Users/me/repo/.claude/worktrees/job-260906-0900', null)).toBe(
      true
    )
  })

  it('says no for a folder nobody answered for, and for one answered with false', () => {
    const read = doc({
      '/Users/me/other': { hasTrustDialogAccepted: true },
      '/Users/me/repo': { hasTrustDialogAccepted: false }
    })
    expect(isTrustedByClaude(read, '/Users/me/repo', null)).toBe(false)
    expect(isTrustedByClaude(read, '/Users/me/fresh', null)).toBe(false)
  })

  it('says no when the file cannot be read', () => {
    const read = (): unknown => {
      throw new Error('ENOENT')
    }
    expect(isTrustedByClaude(read, '/Users/me/repo', null)).toBe(false)
    expect(isTrustedByClaude(() => null, '/Users/me/repo', null)).toBe(false)
  })
})

// CC§9
describe('claudeTrustsFolder stops looking up at the top of the git repo', () => {
  const layout = (): { tmp: string; file: string; repo: string; worktree: string } => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-trust-')))
    const repo = path.join(tmp, 'repo')
    const admin = path.join(repo, '.git', 'worktrees', 'w')
    const worktree = path.join(repo, '.claude', 'worktrees', 'w')
    fs.mkdirSync(admin, { recursive: true })
    fs.mkdirSync(path.join(repo, 'sub'))
    fs.mkdirSync(path.join(tmp, 'plain', 'sub'), { recursive: true })
    fs.mkdirSync(worktree, { recursive: true })
    fs.writeFileSync(path.join(admin, 'commondir'), '../..\n')
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${admin}\n`)
    return { tmp, file: path.join(tmp, '.claude.json'), repo, worktree }
  }
  const trustOnly = (file: string, dir: string): void =>
    fs.writeFileSync(
      file,
      JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } })
    )

  it('says no for a repo inside a trusted folder, and acceptClaudeTrust then records the repo', () => {
    const { tmp, file, repo } = layout()
    trustOnly(file, tmp)

    expect(claudeTrustsFolder(file, repo)).toBe(false)
    expect(claudeTrustsFolder(file, path.join(repo, 'sub'))).toBe(false)
    acceptClaudeTrust(file, repo)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).projects[repo]).toEqual({
      hasTrustDialogAccepted: true
    })
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('says yes for a plain folder inside a trusted folder', () => {
    const { tmp, file } = layout()
    trustOnly(file, tmp)

    expect(claudeTrustsFolder(file, path.join(tmp, 'plain', 'sub'))).toBe(true)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('says yes for a subfolder of a trusted repo and for a worktree under it', () => {
    const { tmp, file, repo, worktree } = layout()
    trustOnly(file, repo)

    expect(claudeTrustsFolder(file, path.join(repo, 'sub'))).toBe(true)
    expect(claudeTrustsFolder(file, worktree)).toBe(true)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

// CC§9
describe('acceptClaudeTrust', () => {
  it('records trust under the real path of a symlinked folder, keeping every other key, and reads it back through the link', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-trust-')))
    const repo = path.join(tmp, 'repo')
    const link = path.join(tmp, 'link')
    fs.mkdirSync(repo)
    fs.symlinkSync(repo, link)
    const file = path.join(tmp, '.claude.json')
    fs.writeFileSync(
      file,
      JSON.stringify({ numStartups: 3, projects: { [repo]: { allowedTools: ['Bash'] } } })
    )

    expect(claudeTrustsFolder(file, link)).toBe(false)
    acceptClaudeTrust(file, link)

    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(doc.numStartups).toBe(3)
    expect(doc.projects[repo]).toEqual({ allowedTools: ['Bash'], hasTrustDialogAccepted: true })
    expect(doc.projects[link]).toBeUndefined()
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(claudeTrustsFolder(file, link)).toBe(true)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('records trust when ~/.claude.json does not exist yet, creating it', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-trust-')))
    const file = path.join(tmp, '.claude.json')

    acceptClaudeTrust(file, tmp)

    expect(claudeTrustsFolder(file, tmp)).toBe(true)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

// CC§10
describe('markClaudeOnboarded', () => {
  const claudeJson = (): string =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-onboarded-')), '.claude.json')

  it('marks the first-run page done, creating the file when missing and keeping every other key', () => {
    const missing = claudeJson()
    markClaudeOnboarded(missing)
    expect(JSON.parse(fs.readFileSync(missing, 'utf8'))).toEqual({ hasCompletedOnboarding: true })

    const fresh = claudeJson()
    fs.writeFileSync(fresh, JSON.stringify({ installMethod: 'native', projects: {} }))
    markClaudeOnboarded(fresh)
    expect(JSON.parse(fs.readFileSync(fresh, 'utf8'))).toEqual({
      installMethod: 'native',
      projects: {},
      hasCompletedOnboarding: true
    })
  })

  it('never overwrites a file it cannot read as JSON', () => {
    const file = claudeJson()
    fs.writeFileSync(file, '{ half')
    markClaudeOnboarded(file)
    expect(fs.readFileSync(file, 'utf8')).toBe('{ half')
  })
})
