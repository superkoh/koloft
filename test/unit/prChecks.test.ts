import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  FAILED_LOG_LIMIT,
  failingChecksText,
  parseChecks,
  runGh,
  trimFailedLog,
  type GhResult
} from '../../src/main/prChecks'

const REPO = { owner: 'acme', repo: 'widgets' }
const ACTIONS_LINK = 'https://github.com/acme/widgets/actions/runs/36829650571/job/110263090912'
const CHECK_RUN_LINK = 'https://github.com/acme/widgets/runs/113283516862'

function answer(code: number | null, stdout = '', stderr = ''): GhResult {
  return { code, stdout, stderr, missing: false }
}

function logLine(text: string, step = 'Run npm test'): string {
  return `check\t${step}\t2026-10-07T13:25:40.2831910Z ${text}`
}

// PLATFORM§32
describe('reading gh pr checks --json name,bucket,link,workflow', () => {
  const two = JSON.stringify([
    { name: 'check', bucket: 'fail', link: ACTIONS_LINK, workflow: 'CI' },
    { name: 'CodeQL', bucket: 'pass', link: CHECK_RUN_LINK, workflow: '' }
  ])

  it('reads the list from exit 0, which gh also uses when a check failed', () => {
    expect(parseChecks(answer(0, two))).toEqual({
      state: 'ok',
      checks: [
        { name: 'check', bucket: 'fail', link: ACTIONS_LINK, workflow: 'CI' },
        { name: 'CodeQL', bucket: 'pass', link: CHECK_RUN_LINK, workflow: '' }
      ]
    })
  })

  it('reads the list whatever the exit code, so exit 8 (checks pending) still has its checks', () => {
    expect(parseChecks(answer(8, two))).toMatchObject({ state: 'ok' })
  })

  it('tells a branch with no pull request (exit 1) from a signed-out gh (exit 4) and a missing gh', () => {
    expect(
      parseChecks(answer(1, '', 'no pull requests found for branch "feature/login"\n'))
    ).toEqual({ state: 'no-pr' })
    expect(
      parseChecks(
        answer(1, '', 'GraphQL: Could not resolve to a PullRequest with the number of 9.')
      )
    ).toEqual({ state: 'no-pr' })
    expect(
      parseChecks(answer(4, '', 'To get started with GitHub CLI, please run:  gh auth login\n'))
    ).toEqual({ state: 'signed-out' })
    expect(parseChecks({ code: null, stdout: '', stderr: '', missing: true })).toEqual({
      state: 'no-gh'
    })
  })

  it("counts a pull request whose repo runs no CI as having no checks, not as GitHub's failure", () => {
    expect(
      parseChecks(answer(1, '', "no checks reported on the 'feature-update' branch\n"))
    ).toEqual({ state: 'ok', checks: [] })
    expect(parseChecks(answer(1, '', 'HTTP 502'))).toEqual({ state: 'failed' })
  })

  describe('with no gh on PATH', () => {
    const savedPath = process.env.PATH
    afterEach(() => {
      process.env.PATH = savedPath
    })

    it('reports gh as missing rather than failed', async () => {
      process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-nogh-'))
      expect((await runGh(['--version'])).missing).toBe(true)
    })
  })
})

describe('the failing log cut to the part around the first error', () => {
  it('drops the job, step and time prefix and the colour codes', () => {
    const raw = [
      logLine('\u001b[36;1mnpm test\u001b[0m'),
      logLine(' FAIL  test/unit/a.test.ts > breaks'),
      logLine('##[error]Process completed with exit code 1.')
    ].join('\n')
    expect(trimFailedLog(raw)).toBe(
      'npm test\n FAIL  test/unit/a.test.ts > breaks\n##[error]Process completed with exit code 1.'
    )
  })

  it('keeps what leads up to the first error and a few lines after it, never the cleanup at the end', () => {
    const lines = [
      ...Array.from({ length: 2000 }, (_, i) => logLine(`setup line ${i}`)),
      logLine('AssertionError: expected 1 to be 2'),
      logLine('##[error]Process completed with exit code 1.'),
      logLine('after 1'),
      logLine('after 2'),
      logLine('after 3'),
      ...Array.from({ length: 500 }, (_, i) => logLine(`Post job cleanup ${i}`))
    ]
    const cut = trimFailedLog(lines.join('\n'))
    expect(cut.length).toBeLessThanOrEqual(FAILED_LOG_LIMIT)
    expect(cut).toContain('AssertionError: expected 1 to be 2')
    expect(
      cut.endsWith('##[error]Process completed with exit code 1.\nafter 1\nafter 2\nafter 3')
    ).toBe(true)
    expect(cut).not.toContain('Post job cleanup')
    expect(cut).not.toContain('setup line 0\n')
  })

  it('keeps the tail when the log has no error marker', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => logLine(`line ${i}`))
    const cut = trimFailedLog(lines.join('\n'))
    expect(cut.endsWith('line 1999')).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(FAILED_LOG_LIMIT)
  })
})

describe('the text Send failing checks puts in the session', () => {
  it('names each failing check with its link and log excerpt, and a check outside Actions with its link only', async () => {
    const asked: string[][] = []
    const gh = async (args: string[]): Promise<GhResult> => {
      asked.push(args)
      if (args[0] === 'pr') {
        return answer(
          0,
          JSON.stringify([
            { name: 'check', bucket: 'fail', link: ACTIONS_LINK, workflow: 'CI' },
            { name: 'CodeQL', bucket: 'fail', link: CHECK_RUN_LINK, workflow: '' },
            { name: 'lint', bucket: 'pass', link: ACTIONS_LINK, workflow: 'CI' }
          ])
        )
      }
      return answer(0, [logLine('boom'), logLine('##[error]exit 1')].join('\n'))
    }
    const text = await failingChecksText(gh, REPO, 265)
    expect(text).toBe(
      [
        'CI check "check" (workflow CI) failed on pull request #265 of acme/widgets.',
        `Full log: ${ACTIONS_LINK}`,
        '',
        '--- log excerpt (around the first error) ---',
        'boom',
        '##[error]exit 1',
        '',
        'CI check "CodeQL" failed on pull request #265 of acme/widgets.',
        `Full log: ${CHECK_RUN_LINK}`,
        '',
        ''
      ].join('\n')
    )
    expect(asked).toEqual([
      ['pr', 'checks', '265', '--repo', 'acme/widgets', '--json', 'name,bucket,link,workflow'],
      ['run', 'view', '--job', '110263090912', '--repo', 'acme/widgets', '--log-failed']
    ])
  })

  it('has nothing to send when no check failed', async () => {
    const gh = async (): Promise<GhResult> =>
      answer(0, JSON.stringify([{ name: 'check', bucket: 'pending', link: '', workflow: 'CI' }]))
    expect(await failingChecksText(gh, REPO, 265)).toBeNull()
  })
})
