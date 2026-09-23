import { describe, expect, it } from 'vitest'
import { claudeArgv } from '../../src/main/claudeArgs'
import type { CronEffort, CronPermission } from '../../src/shared/types'

// D11 (new-session-entrances design) §08/§11 S1): the argv both claude spawn
// paths build. It is the only unit seam for main's launch line — index.ts cannot be
// loaded here — and the reason it exists is that an illegal `-w` name used to be
// dropped silently, launching in the repo root instead of the worktree the caller
// asked for.

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
    // these all passed `^[A-Za-z0-9._-]{1,64}$` and would have launched in the repo
    // root with no worktree at all — the shared validator is what closes that gap
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

// item 6: a remote launch mints the new session's id itself (no shim over there)
// and hands it to claude, so the builder both launches share has to be able to say it.
describe('claudeArgv (a brand-new session id)', () => {
  it('asks claude to use the minted id, ahead of the worktree flag', () => {
    const id = '9f8c1b2a-3d4e-5f60-7182-93a4b5c6d7e8'
    expect(claudeArgv(BASE, { sessionId: id, worktree: 'n1', permission: 'skipAll' })).toEqual({
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
    // the id comes off a persisted file and lands in a shell command line
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

// BB-E31 (§4.7): a scheduled job carries a model and a permission, and both come
// off cron.json — a file a person can hand-edit. Every token here is joined with spaces
// into a line typed into a login shell, so the launch line refuses what the form should
// have refused rather than dropping the flag and running with the wrong settings.
describe('claudeArgv (BB-E31: a scheduled job’s model and permission)', () => {
  it('refuses a model that is not a plain token', () => {
    for (const model of ['sonnet; rm -rf ~', 'a b', '-sonnet', '$(id)', 'a'.repeat(82)]) {
      expect(claudeArgv(BASE, { model }), model).toEqual({ ok: false, code: 'invalid-args' })
    }
  })

  it('refuses a permission word it does not know', () => {
    expect(claudeArgv(BASE, { permission: 'bypass' as CronPermission })).toEqual({
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
    expect(claudeArgv(BASE, { model: 'sonnet', effort: 'xhigh', permission: 'skipAll' })).toEqual({
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
    expect(claudeArgv(BASE, { permission: 'skipAll' })).toEqual({
      ok: true,
      argv: ['claude', '--dangerously-skip-permissions']
    })
  })

  it('adds nothing at all for "same" — the run gets the settings the workspace has', () => {
    expect(claudeArgv(BASE, { permission: 'same' })).toEqual({ ok: true, argv: ['claude'] })
  })

  // the order is the contract: a test that only checked the set would pass on a line
  // whose flags sit in an order the caller never asked for
  it('keeps the worktree flag ahead of the model and the permission', () => {
    expect(
      claudeArgv(BASE, { worktree: 'n1', model: 'sonnet', permission: 'acceptEdits' })
    ).toEqual({
      ok: true,
      argv: ['claude', '-w', 'n1', '--model', 'sonnet', '--permission-mode', 'acceptEdits']
    })
  })
})
