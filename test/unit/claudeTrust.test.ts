import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  acceptBypassWarning,
  acceptClaudeTrust,
  bypassWarningAccepted,
  claudeTrustsFolder,
  isTrustedByClaude
} from '../../src/main/claudeTrust'

// CC§9
describe('the one-time "skip permissions" warning Claude shows', () => {
  const files = (): { dir: string; claudeJson: string; settings: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-bypass-'))
    return {
      dir,
      claudeJson: path.join(dir, '.claude.json'),
      settings: path.join(dir, '.claude', 'settings.json')
    }
  }

  it('counts as accepted by either key Claude reads, and not when neither file says so', () => {
    const f = files()
    expect(bypassWarningAccepted(f.claudeJson, f.settings)).toBe(false)
    fs.writeFileSync(f.claudeJson, JSON.stringify({ bypassPermissionsModeAccepted: true }))
    expect(bypassWarningAccepted(f.claudeJson, f.settings)).toBe(true)
    fs.rmSync(f.claudeJson)
    fs.mkdirSync(path.dirname(f.settings))
    fs.writeFileSync(f.settings, JSON.stringify({ skipDangerousModePermissionPrompt: true }))
    expect(bypassWarningAccepted(f.claudeJson, f.settings)).toBe(true)
    fs.rmSync(f.dir, { recursive: true, force: true })
  })

  it('accepting writes only skipDangerousModePermissionPrompt and keeps every other setting', () => {
    const f = files()
    expect(acceptBypassWarning(f.settings)).toBe(true)
    expect(JSON.parse(fs.readFileSync(f.settings, 'utf8'))).toEqual({
      skipDangerousModePermissionPrompt: true
    })
    fs.writeFileSync(f.settings, JSON.stringify({ model: 'opus', hooks: { Stop: [] } }))
    acceptBypassWarning(f.settings)
    expect(JSON.parse(fs.readFileSync(f.settings, 'utf8'))).toEqual({
      model: 'opus',
      hooks: { Stop: [] },
      skipDangerousModePermissionPrompt: true
    })
    fs.rmSync(f.dir, { recursive: true, force: true })
  })

  it('never overwrites a settings file it cannot read as JSON', () => {
    const f = files()
    fs.mkdirSync(path.dirname(f.settings))
    fs.writeFileSync(f.settings, '{ "model": "opus", ')
    expect(acceptBypassWarning(f.settings)).toBe(false)
    expect(fs.readFileSync(f.settings, 'utf8')).toBe('{ "model": "opus", ')
    fs.rmSync(f.dir, { recursive: true, force: true })
  })
})

const doc =
  (projects: Record<string, unknown>): (() => unknown) =>
  () => ({ projects })

// CC§9
describe('isTrustedByClaude', () => {
  it('says yes for the folder itself', () => {
    const read = doc({ '/Users/me/repo': { hasTrustDialogAccepted: true } })
    expect(isTrustedByClaude(read, '/Users/me/repo')).toBe(true)
  })

  it('says yes when an ancestor was trusted', () => {
    const read = doc({ '/Users/me/repo': { hasTrustDialogAccepted: true } })
    expect(isTrustedByClaude(read, '/Users/me/repo/.claude/worktrees/job-260906-0900')).toBe(true)
  })

  it('says no for a folder nobody answered for, and for one answered with false', () => {
    const read = doc({
      '/Users/me/other': { hasTrustDialogAccepted: true },
      '/Users/me/repo': { hasTrustDialogAccepted: false }
    })
    expect(isTrustedByClaude(read, '/Users/me/repo')).toBe(false)
    expect(isTrustedByClaude(read, '/Users/me/fresh')).toBe(false)
  })

  it('says no when the file cannot be read', () => {
    const read = (): unknown => {
      throw new Error('ENOENT')
    }
    expect(isTrustedByClaude(read, '/Users/me/repo')).toBe(false)
    expect(isTrustedByClaude(() => null, '/Users/me/repo')).toBe(false)
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
})
