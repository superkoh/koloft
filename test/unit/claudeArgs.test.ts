import { describe, expect, it } from 'vitest'
import { claudeArgv } from '../../src/main/claudeArgs'
import type { CronEffort, LaunchPermission } from '../../src/shared/types'

const BASE = 'claude'

describe('claudeArgv (T-ARG-01: the valid argv)', () => {
  it('is the bare base with nothing asked for', () => {
    expect(claudeArgv(BASE, {})).toEqual({ ok: true, argv: ['claude'] })
  })

  it('carries a legal worktree name as `-w <name>`', () => {
    expect(claudeArgv(BASE, { worktree: 'payment-retry' })).toEqual({
      ok: true,
      argv: ['claude', '-w', 'payment-retry']
    })
  })

  it('combines --resume with -w, resume first (D10)', () => {
    expect(claudeArgv(BASE, { resumeSessionId: 'abc-123', worktree: 'v1.2_x' })).toEqual({
      ok: true,
      argv: ['claude', '--resume', 'abc-123', '-w', 'v1.2_x']
    })
  })

  it('keeps the test seam base (KOLOFT_CLAUDE_CMD points at the e2e fake claude)', () => {
    expect(claudeArgv('/tmp/fake/claude', { resumeSessionId: 'abc-123' })).toEqual({
      ok: true,
      argv: ['/tmp/fake/claude', '--resume', 'abc-123']
    })
  })
})

describe('claudeArgv (T-ARG-02: an illegal worktree name is refused, never dropped)', () => {
  it('verdicts invalid-args and hands back no argv', () => {
    for (const worktree of ['', 'a b', 'a/b', 'feat:x', 'a;id', 'a'.repeat(65)]) {
      expect(claudeArgv(BASE, { worktree }), worktree).toEqual({ ok: false, code: 'invalid-args' })
    }
  })

  it('refuses the names main’s old bare regex let through (git ref rules)', () => {
    for (const worktree of ['.hidden', 'a.', 'a..b', 'a.lock']) {
      expect(claudeArgv(BASE, { worktree }), worktree).toEqual({ ok: false, code: 'invalid-args' })
    }
  })

  it('refuses the whole launch, resume included, when the name is bad', () => {
    expect(claudeArgv(BASE, { resumeSessionId: 'abc-123', worktree: 'a b' })).toEqual({
      ok: false,
      code: 'invalid-args'
    })
  })
})

describe('claudeArgv (a brand-new session id, minted by a remote launch that has no shim)', () => {
  it('asks claude to use the minted id, ahead of the worktree flag', () => {
    const id = '9f8c1b2a-3d4e-5f60-7182-93a4b5c6d7e8'
    expect(claudeArgv(BASE, { sessionId: id, worktree: 'n1', permission: 'bypass' })).toEqual({
      ok: true,
      argv: ['claude', '--session-id', id, '-w', 'n1', '--dangerously-skip-permissions']
    })
  })

  it('refuses an id that is not a plain token', () => {
    for (const sessionId of ['a b', 'a;rm -rf /', '$(id)', 'a/b', '']) {
      expect(claudeArgv(BASE, { sessionId }), sessionId).toEqual({
        ok: false,
        code: 'invalid-args'
      })
    }
  })
})

describe('claudeArgv (T-ARG-03: the resumed id keeps its own verdict)', () => {
  it('refuses an id that is not a uuid-shaped token', () => {
    for (const resumeSessionId of ['a b', 'a;rm -rf /', '$(id)', 'a/b', '']) {
      expect(claudeArgv(BASE, { resumeSessionId }), resumeSessionId).toEqual({
        ok: false,
        code: 'invalid-args'
      })
    }
  })

  it('accepts the uuid shape claude itself writes', () => {
    const id = '9f8c1b2a-3d4e-5f60-7182-93a4b5c6d7e8'
    expect(claudeArgv(BASE, { resumeSessionId: id })).toEqual({
      ok: true,
      argv: ['claude', '--resume', id]
    })
  })
})

describe('claudeArgv (BB-E31: a scheduled job’s model and permission)', () => {
  it('refuses a model that is not a plain token', () => {
    for (const model of ['sonnet; rm -rf ~', 'a b', '-sonnet', '$(id)', 'a'.repeat(82)]) {
      expect(claudeArgv(BASE, { model }), model).toEqual({ ok: false, code: 'invalid-args' })
    }
  })

  it('refuses a permission word it does not know', () => {
    expect(claudeArgv(BASE, { permission: 'skipAll' as LaunchPermission })).toEqual({
      ok: false,
      code: 'invalid-args'
    })
  })

  it('refuses a thinking effort claude does not know', () => {
    expect(claudeArgv(BASE, { effort: 'ultra' as CronEffort })).toEqual({
      ok: false,
      code: 'invalid-args'
    })
  })

  it('puts the thinking effort after the model', () => {
    expect(claudeArgv(BASE, { model: 'sonnet', effort: 'xhigh', permission: 'bypass' })).toEqual({
      ok: true,
      argv: ['claude', '--model', 'sonnet', '--effort', 'xhigh', '--dangerously-skip-permissions']
    })
  })

  it('asks for the model and the accept-edits mode', () => {
    expect(claudeArgv(BASE, { model: 'sonnet', permission: 'acceptEdits' })).toEqual({
      ok: true,
      argv: ['claude', '--model', 'sonnet', '--permission-mode', 'acceptEdits']
    })
  })

  it('asks to skip every permission question', () => {
    expect(claudeArgv(BASE, { permission: 'bypass' })).toEqual({
      ok: true,
      argv: ['claude', '--dangerously-skip-permissions']
    })
  })

  it('adds nothing at all for "same" — the run gets the settings the workspace has', () => {
    expect(claudeArgv(BASE, { permission: 'default' })).toEqual({ ok: true, argv: ['claude'] })
  })

  it('keeps the worktree flag ahead of the model and the permission', () => {
    expect(
      claudeArgv(BASE, { worktree: 'n1', model: 'sonnet', permission: 'acceptEdits' })
    ).toEqual({
      ok: true,
      argv: ['claude', '-w', 'n1', '--model', 'sonnet', '--permission-mode', 'acceptEdits']
    })
  })
})
