import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { koloftAssist } from '../../src/main/assist'
import type { AssistSetting, BackendId } from '../../src/shared/types'

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

const JOB = { system: 'You write short titles.', prompt: 'Task:\nfix the login crash' }

function assistWith(
  setting: AssistSetting,
  bins: Partial<Record<BackendId, string>>,
  off: BackendId[] = []
) {
  return koloftAssist({
    setting: () => setting,
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
  it('runs nothing and answers nothing while it is off or not chosen yet, so every caller takes its non-AI way', async () => {
    const claude = recordingBinary('claude', 'a title')
    for (const setting of [null, { on: false, backend: 'claude' as const }]) {
      expect(await assistWith(setting, { claude: claude.bin })(JOB)).toBeNull()
    }
    expect(read(claude.log + '.argv')).toBeNull()
  })

  it('answers nothing when neither tool has a Koloft account to run on', async () => {
    expect(await assistWith({ on: true, backend: 'codex' }, {})(JOB)).toBeNull()
  })

  it('runs on the other tool when the chosen one has no usable account', async () => {
    const claude = recordingBinary('claude', 'From Claude')
    const reply = await assistWith({ on: true, backend: 'codex' }, { claude: claude.bin })(JOB)
    expect(reply?.trim()).toBe('From Claude')
  })

  it('never runs a tool turned off in Settings ▸ Sessions, even when it is the chosen one', async () => {
    const codex = recordingBinary('codex', 'From Codex')
    const claude = recordingBinary('claude', 'From Claude')
    const reply = await assistWith(
      { on: true, backend: 'codex' },
      { codex: codex.bin, claude: claude.bin },
      ['codex']
    )(JOB)
    expect(reply?.trim()).toBe('From Claude')
    expect(read(codex.log + '.argv')).toBeNull()
  })

  // CC§9
  it('on Claude, runs one Haiku print with the job’s system prompt and no tools, the prompt on stdin', async () => {
    const claude = recordingBinary('claude', 'Fix Login Crash')
    const reply = await assistWith({ on: true, backend: 'claude' }, { claude: claude.bin })(JOB)
    expect(reply?.trim()).toBe('Fix Login Crash')
    const argv = read(claude.log + '.argv')!.split('\n')
    expect(argv.slice(0, 3)).toEqual(['-p', '--model', 'haiku'])
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe(JOB.system)
    expect(read(claude.log + '.stdin')).toBe(JOB.prompt)
  })

  // CODEX§15
  it('on Codex, runs one throwaway gpt-6-luna exec in the picked account’s home, the system text ahead of the prompt on stdin', async () => {
    const codex = recordingBinary('codex', 'Fix Login Crash')
    const reply = await assistWith({ on: true, backend: 'codex' }, { codex: codex.bin })(JOB)
    expect(reply?.trim()).toBe('Fix Login Crash')
    const argv = read(codex.log + '.argv')!
      .trim()
      .split('\n')
    expect(argv[0]).toBe('exec')
    expect(argv).toContain('--ephemeral')
    expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-6-luna')
    expect(argv[argv.length - 1]).toBe('-')
    expect(read(codex.log + '.stdin')).toBe(`${JOB.system}\n\n${JOB.prompt}`)
    expect(read(codex.log + '.home')?.trim()).toBe('/homes/work')
  })

  describe('a Codex one-shot that is late', () => {
    const LIMIT_MS = 400

    function codexThatAnswersOnTry(answers: string[]): { bin: string; tries: () => number } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-assist-late-'))
      const bin = path.join(dir, 'codex')
      const count = path.join(dir, 'tries')
      const cases = answers.map((step, i) => `  ${i + 1}) ${step} ;;`).join('\n')
      fs.writeFileSync(
        bin,
        `#!/bin/sh\ncat > /dev/null\necho x >> ${JSON.stringify(count)}\n` +
          `n=$(wc -l < ${JSON.stringify(count)} | tr -d ' ')\ncase "$n" in\n${cases}\nesac\n`,
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
          setting: () => ({ on: true, backend: 'codex' }),
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
      const started = Date.now()
      const reply = await (await lateAssist(codex.bin))(JOB)
      expect(reply?.trim()).toBe('From the second try')
      expect(codex.tries()).toBe(2)
      expect(Date.now() - started).toBeLessThan(2 * LIMIT_MS + 1_000)
    })

    it('still takes the first try’s answer when it comes in after the second try started', async () => {
      const codex = codexThatAnswersOnTry([
        `sleep ${(1.5 * LIMIT_MS) / 1000}; echo From the first try`,
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
    const reply = await assistWith({ on: true, backend: 'claude' }, { muse: muse.bin })(JOB)
    expect(reply).toBe('From Muse')
  })

  // MUSE§1
  it('on Muse, runs one exec that leaves no session behind, and answers with the text of its finished record', async () => {
    const muse = recordingBinary('muse', museStream('Fix Login Crash'))
    const reply = await assistWith({ on: true, backend: 'muse' }, { muse: muse.bin })(JOB)
    expect(reply).toBe('Fix Login Crash')
    const argv = read(muse.log + '.argv')!.split('\n')
    expect(argv[0]).toBe('exec')
    expect(argv).toEqual(expect.arrayContaining(['--json', '--no-session-log']))
    expect(argv.join('\n')).toContain(`${JOB.system}\n\n${JOB.prompt}`)
  })
})
