import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { koloftAssist } from '../../src/main/assist'
import type { AssistSetting } from '../../src/shared/types'

function recordingBinary(name: string, reply: string): { bin: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-assist-'))
  const bin = path.join(dir, name)
  const log = path.join(dir, 'calls')
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log + '.argv')}\n` +
      `cat > ${JSON.stringify(log + '.stdin')}\nprintf '%s\\n' "$CODEX_HOME" > ${JSON.stringify(log + '.home')}\n` +
      `echo ${JSON.stringify(reply)}\n`,
    { mode: 0o755 }
  )
  return { bin, log }
}

const read = (file: string): string | null =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null

const JOB = { system: 'You write short titles.', prompt: 'Task:\nfix the login crash' }

function assistWith(setting: AssistSetting, bins: { claude?: string; codex?: string }) {
  return koloftAssist({
    setting: () => setting,
    claude: async () => (bins.claude ? { binary: bins.claude, env: {} } : null),
    codex: async () =>
      bins.codex ? { binary: bins.codex, env: { CODEX_HOME: '/homes/work' } } : null
  })
}

describe('Koloft Assist', () => {
  it('runs nothing and answers nothing while it is off or not chosen yet, so every caller takes its non-AI way', async () => {
    const claude = recordingBinary('claude', 'a title')
    for (const setting of [null, { on: false, backend: 'claude' as const }]) {
      expect(await assistWith(setting, { claude: claude.bin })(JOB)).toBeNull()
    }
    expect(read(claude.log + '.argv')).toBeNull()
  })

  it('answers nothing when the chosen tool has no Koloft account to run on', async () => {
    expect(await assistWith({ on: true, backend: 'codex' }, {})(JOB)).toBeNull()
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
})
