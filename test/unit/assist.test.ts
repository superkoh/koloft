import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { koloftAssist } from '../../src/main/assist'
import { DEFAULT_SETTINGS, type AssistSetting, type BackendId } from '../../src/shared/types'

function recordingBinary(name: string, reply: string): { bin: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-assist-'))
  const bin = path.join(dir, name)
  const log = path.join(dir, 'calls')
  const replyFile = path.join(dir, 'reply')
  fs.writeFileSync(replyFile, reply + '\n')
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log + '.argv')}\n` +
      `cat > ${JSON.stringify(log + '.stdin')}\nprintf '%s\\n' "$CODEX_HOME" > ${JSON.stringify(log + '.home')}\n` +
      `cat ${JSON.stringify(replyFile)}\n`,
    { mode: 0o755 }
  )
  return { bin, log }
}

const read = (file: string): string | null =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null

const JOB = {
  row: 'title' as const,
  system: 'You write short titles.',
  prompt: 'Task:\nfix the login crash'
}

const picksOf = (assist: AssistSetting) => () => ({
  assist,
  sessionMethods: DEFAULT_SETTINGS.sessionMethods,
  accounts: []
})

function assistWith(
  assist: AssistSetting,
  bins: Partial<Record<BackendId, string>>,
  off: BackendId[] = []
) {
  return koloftAssist({
    picks: picksOf(assist),
    enabled: (backend) => !off.includes(backend),
    target: async (backend) => {
      const binary = bins[backend]
      if (!binary) return null
      return { binary, env: backend === 'codex' ? { CODEX_HOME: '/homes/work' } : {} }
    }
  })
}

function museStream(answer: string): string {
  return [
    { payload_type: 'runtime.session', payload: { event: { kind: 'started' } } },
    { payload_type: 'run.terminal.completed', payload: { terminal: 'completed', text: answer } }
  ]
    .map((r) => JSON.stringify(r))
    .join('\n')
}

describe('Koloft Assist', () => {
  it('runs with nothing chosen, on whichever tool has an account', async () => {
    const codex = recordingBinary('codex', 'From Codex')
    expect((await assistWith({}, { codex: codex.bin })(JOB))?.trim()).toBe('From Codex')
  })

  it('answers nothing when neither tool has a Koloft account to run on', async () => {
    expect(await assistWith({ backend: 'codex' }, {})(JOB)).toBeNull()
  })

  it('runs on the other tool when the chosen one has no usable account', async () => {
    const claude = recordingBinary('claude', 'From Claude')
    const reply = await assistWith({ backend: 'codex' }, { claude: claude.bin })(JOB)
    expect(reply?.trim()).toBe('From Claude')
  })

  it('never runs a tool turned off in Settings ▸ Sessions, even when it is the chosen one', async () => {
    const codex = recordingBinary('codex', 'From Codex')
    const claude = recordingBinary('claude', 'From Claude')
    const reply = await assistWith({ backend: 'codex' }, { codex: codex.bin, claude: claude.bin }, [
      'codex'
    ])(JOB)
    expect(reply?.trim()).toBe('From Claude')
    expect(read(codex.log + '.argv')).toBeNull()
  })

  // CC§9
  it('on Claude, runs one Haiku print with the job’s system prompt and no tools, the prompt on stdin', async () => {
    const claude = recordingBinary('claude', 'Fix Login Crash')
    const reply = await assistWith({ backend: 'claude' }, { claude: claude.bin })(JOB)
    expect(reply?.trim()).toBe('Fix Login Crash')
    const argv = read(claude.log + '.argv')!.split('\n')
    expect(argv.slice(0, 3)).toEqual(['-p', '--model', 'haiku'])
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe(JOB.system)
    expect(read(claude.log + '.stdin')).toBe(JOB.prompt)
  })

  // CODEX§15
  it('on Codex, runs one throwaway gpt-6-luna exec at low effort in the picked account’s home, the system text ahead of the prompt on stdin', async () => {
    const codex = recordingBinary('codex', 'Fix Login Crash')
    const reply = await assistWith({ backend: 'codex' }, { codex: codex.bin })(JOB)
    expect(reply?.trim()).toBe('Fix Login Crash')
    const argv = read(codex.log + '.argv')!
      .trim()
      .split('\n')
    expect(argv[0]).toBe('exec')
    expect(argv).toContain('--ephemeral')
    expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-6-luna')
    expect(argv[argv.indexOf('-c') + 1]).toBe('model_reasoning_effort="low"')
    expect(argv[argv.length - 1]).toBe('-')
    expect(read(codex.log + '.stdin')).toBe(`${JOB.system}\n\n${JOB.prompt}`)
    expect(read(codex.log + '.home')?.trim()).toBe('/homes/work')
  })

  it('runs a job on the model and effort its row picked, and on the row’s own tool', async () => {
    const claude = recordingBinary('claude', 'NEWS')
    const codex = recordingBinary('codex', 'NEWS')
    await assistWith(
      { backend: 'codex', rows: { turn: { backend: 'claude', model: 'opus', effort: 'high' } } },
      { claude: claude.bin, codex: codex.bin }
    )({ ...JOB, row: 'turn' })
    expect(
      read(claude.log + '.argv')!
        .split('\n')
        .slice(0, 5)
    ).toEqual(['-p', '--model', 'opus', '--effort', 'high'])
    expect(read(codex.log + '.argv')).toBeNull()
  })

  describe('a model the account does not take', () => {
    function codexWithout(model: string): { bin: string; models: () => string[] } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-assist-refused-'))
      const bin = path.join(dir, 'codex')
      const asked = path.join(dir, 'asked')
      fs.writeFileSync(
        bin,
        `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' "$*" >> ${JSON.stringify(asked)}\n` +
          `case "$*" in *${model}*) echo "ERROR: The '${model}' model is not supported when using Codex with a ChatGPT account." >&2; exit 1 ;; esac\necho ACT\n`,
        { mode: 0o755 }
      )
      return {
        bin,
        models: () =>
          (read(asked) ?? '')
            .trim()
            .split('\n')
            .map((argv) => argv.match(/-m (\S+)/)?.[1] ?? '')
      }
    }

    // CODEX§15
    it('runs once more on the model every account takes, when the refused one came from Koloft’s own table', async () => {
      const codex = codexWithout('gpt-6.1-sol')
      const reply = await assistWith(
        { backend: 'codex' },
        { codex: codex.bin }
      )({
        ...JOB,
        row: 'turn'
      })
      expect(reply?.trim()).toBe('ACT')
      expect(codex.models()).toEqual(['gpt-6.1-sol', 'gpt-6-luna'])
    })

    it('does not run again after a failure that is not about the model', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-assist-auth-'))
      const bin = path.join(dir, 'codex')
      const runs = path.join(dir, 'runs')
      fs.writeFileSync(
        bin,
        `#!/bin/sh\ncat > /dev/null\necho x >> ${JSON.stringify(runs)}\necho "ERROR: not signed in" >&2\nexit 1\n`,
        { mode: 0o755 }
      )
      const reply = await assistWith({ backend: 'codex' }, { codex: bin })({ ...JOB, row: 'turn' })
      expect(reply).toBeNull()
      expect(read(runs)?.trim().split('\n')).toHaveLength(1)
    })

    it('answers nothing, with no second run, when the owner picked that model', async () => {
      const codex = codexWithout('gpt-6-astra')
      const reply = await assistWith(
        { backend: 'codex', rows: { turn: { backend: 'codex', model: 'gpt-6-astra' } } },
        { codex: codex.bin }
      )({ ...JOB, row: 'turn' })
      expect(reply).toBeNull()
      expect(codex.models()).toEqual(['gpt-6-astra'])
    })
  })

  describe('a Codex one-shot that is late', () => {
    const LIMIT_MS = 1000

    function codexThatAnswersOnTry(answers: string[]): { bin: string; tries: () => number } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-assist-late-'))
      const bin = path.join(dir, 'codex')
      const count = path.join(dir, 'tries')
      const cases = answers.map((step, i) => `  ${i + 1}) ${step} ;;`).join('\n')
      fs.writeFileSync(
        bin,
        `#!/bin/sh\ncount_tries() { wc -l < ${JSON.stringify(count)} | tr -d ' '; }\n` +
          `cat > /dev/null\necho x >> ${JSON.stringify(count)}\n` +
          `n=$(count_tries)\ncase "$n" in\n${cases}\nesac\n`,
        { mode: 0o755 }
      )
      return { bin, tries: () => read(count)?.trim().split('\n').length ?? 0 }
    }

    async function lateAssist(codex: string) {
      vi.resetModules()
      process.env.KOLOFT_ASSIST_TIMEOUT_MS = String(LIMIT_MS)
      try {
        const { koloftAssist: fresh } = await import('../../src/main/assist')
        return fresh({
          picks: picksOf({
            backend: 'codex',
            rows: { title: { backend: 'codex', model: 'gpt-6-luna' } }
          }),
          enabled: () => true,
          target: async () => ({ binary: codex, env: {} })
        })
      } finally {
        delete process.env.KOLOFT_ASSIST_TIMEOUT_MS
      }
    }

    // CODEX§15
    it('starts a second try at the time limit and answers with whichever comes back first', async () => {
      const codex = codexThatAnswersOnTry(['exec sleep 30', 'echo From the second try'])
      const reply = await (await lateAssist(codex.bin))(JOB)
      expect(reply?.trim()).toBe('From the second try')
      expect(codex.tries()).toBe(2)
    })

    it('still takes the first try’s answer when it comes in after the second try started', async () => {
      const codex = codexThatAnswersOnTry([
        `until [ "$(count_tries)" -ge 2 ]; do sleep 0.05; done; sleep ${(0.4 * LIMIT_MS) / 1000}; echo From the first try`,
        'exec sleep 30'
      ])
      const reply = await (await lateAssist(codex.bin))(JOB)
      expect(reply?.trim()).toBe('From the first try')
      expect(codex.tries()).toBe(2)
    })

    it('does not try again when the first try fails before the time limit', async () => {
      const codex = codexThatAnswersOnTry(['exit 1', 'echo From the second try'])
      expect(await (await lateAssist(codex.bin))(JOB)).toBeNull()
      expect(codex.tries()).toBe(1)
    })
  })

  it('runs on the third tool when neither of the others can', async () => {
    const muse = recordingBinary('muse', museStream('From Muse'))
    const reply = await assistWith({ backend: 'claude' }, { muse: muse.bin })(JOB)
    expect(reply).toBe('From Muse')
  })

  // MUSE§1
  it('on Muse, runs one exec that leaves no session behind, and answers with the text of its finished record', async () => {
    const muse = recordingBinary('muse', museStream('Fix Login Crash'))
    const reply = await assistWith({ backend: 'muse' }, { muse: muse.bin })(JOB)
    expect(reply).toBe('Fix Login Crash')
    const argv = read(muse.log + '.argv')!.split('\n')
    expect(argv[0]).toBe('exec')
    expect(argv).toEqual(expect.arrayContaining(['--json', '--no-session-log']))
    expect(argv.join('\n')).toContain(`${JOB.system}\n\n${JOB.prompt}`)
  })
})
