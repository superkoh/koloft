import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOLD_SCRIPT } from '../../src/main/resourceGuard'
import { BUSY_MARKER, RELEASE_AFTER_FILE } from '../../src/main/machineRoom'

let dir: string
let script: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-hold-'))
  script = path.join(dir, 'hold.sh')
  fs.writeFileSync(script, HOLD_SCRIPT, { mode: 0o755 })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const BASH_TOOL = (command: string): string =>
  JSON.stringify({ tool_name: 'Bash', tool_input: { command } })

function hold(
  input: string,
  most?: number
): { done: Promise<{ code: number | null; out: string; ms: number }> } {
  const t = Date.now()
  const kid = spawn('bash', [script, dir, 'tab-1', 'hold', ...(most ? [String(most)] : [])])
  let out = ''
  kid.stdout.on('data', (d) => (out += d))
  kid.stdin.end(input)
  return {
    done: new Promise((resolve) =>
      kid.on('exit', (code) => resolve({ code, out, ms: Date.now() - t }))
    )
  }
}

const busy = (): void => fs.writeFileSync(path.join(dir, BUSY_MARKER), '')
const heldFiles = (): string[] => fs.readdirSync(dir).filter((n) => n.endsWith('.held'))
const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
}

describe('the hook that holds a background session’s next command while the machine is busy', () => {
  it('lets a command run at once, saying nothing, while the machine is roomy', async () => {
    const r = await hold(BASH_TOOL('npm test')).done
    expect(r).toMatchObject({ code: 0, out: '' })
    expect(r.ms).toBeLessThan(1500)
  })

  it('never holds a koloft command, so a held session can still report and close', async () => {
    busy()
    for (const call of [
      BASH_TOOL('koloft session send abc done'),
      JSON.stringify(
        {
          toolCall: { name: 'run_command', args: { CommandLine: 'koloft session send abc done' } }
        },
        null,
        2
      )
    ]) {
      const r = await hold(call, 3).done
      expect(r, call).toMatchObject({ code: 0, out: '' })
      expect(r.ms, call).toBeLessThan(1500)
    }
  })

  it('holds only a shell command, whichever agent asks — Codex and Claude Code’s Bash, Muse’s bash, Antigravity’s run_command even pretty-printed — and lets a file read or write run at once', async () => {
    busy()
    for (const other of [
      { tool_name: 'Read', tool_input: { file_path: 'a' } },
      { tool_name: 'write_file', tool_input: { path: 'a', content: 'x' } },
      { toolCall: { name: 'view_file', args: { AbsolutePath: '/a' } } }
    ]) {
      const r = await hold(JSON.stringify(other), 3).done
      expect(r.ms, JSON.stringify(other)).toBeLessThan(1500)
    }
    for (const shell of [
      JSON.stringify({ tool_name: 'bash', tool_input: { command: 'npm test' } }),
      JSON.stringify(
        { toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } } },
        null,
        2
      )
    ]) {
      const h = hold(shell)
      await until(() => heldFiles().length === 1)
      expect(heldFiles(), shell).toHaveLength(1)
      fs.writeFileSync(path.join(dir, 'tab-1.free'), '')
      await h.done
      fs.rmSync(path.join(dir, 'tab-1.free'))
    }
  }, 15_000)

  it('never holds a session the owner freed', async () => {
    busy()
    fs.writeFileSync(path.join(dir, 'tab-1.free'), '')
    const r = await hold(BASH_TOOL('npm test')).done
    expect(r.ms).toBeLessThan(1500)
  })

  it('while busy it holds, shows Koloft which command waits, and lets go once the machine is roomy, claiming the next release slot', async () => {
    busy()
    const h = hold(BASH_TOOL('npx playwright test'))
    await until(() => heldFiles().length === 1)
    const [file] = heldFiles()
    expect(file).toMatch(/^tab-1\.\d+\.held$/)
    expect(fs.readFileSync(path.join(dir, file), 'utf8')).toMatch(/^\d+\nnpx playwright test\n$/)
    fs.rmSync(path.join(dir, BUSY_MARKER))
    const r = await h.done
    expect(r).toMatchObject({ code: 0, out: '' })
    expect(heldFiles()).toEqual([])
    const after = Number(fs.readFileSync(path.join(dir, RELEASE_AFTER_FILE), 'utf8'))
    expect(after).toBeGreaterThan(Date.now() / 1000)
  }, 15_000)

  it('of two commands that see the machine turn roomy in the same second, only one goes; the other waits out the gap', async () => {
    busy()
    const a = hold(BASH_TOOL('npm run build'))
    const b = hold(BASH_TOOL('npm test'))
    await until(() => heldFiles().length === 2)
    fs.rmSync(path.join(dir, BUSY_MARKER))
    await Promise.race([a.done, b.done])
    await new Promise((r) => setTimeout(r, 1500))
    expect(heldFiles()).toHaveLength(1)
    fs.writeFileSync(path.join(dir, 'tab-1.free'), '')
    await Promise.all([a.done, b.done])
  }, 20_000)

  it('lets go when the owner frees the session while it waits', async () => {
    busy()
    const h = hold(BASH_TOOL('npm run build'))
    await until(() => heldFiles().length === 1)
    fs.writeFileSync(path.join(dir, 'tab-1.free'), '')
    const r = await h.done
    expect(r.ms).toBeLessThan(4000)
  }, 15_000)

  it('gives up waiting after the most it may wait, counted in whole seconds, and lets the command run', async () => {
    busy()
    const r = await hold(BASH_TOOL('npm run build'), 3).done
    expect(r).toMatchObject({ code: 0, out: '' })
    expect(r.ms).toBeGreaterThanOrEqual(2000)
    expect(r.ms).toBeLessThan(6000)
  }, 15_000)

  it('waits its turn behind a release that just happened, even on a roomy machine', async () => {
    fs.writeFileSync(path.join(dir, RELEASE_AFTER_FILE), `${Math.ceil(Date.now() / 1000) + 600}\n`)
    const r = await hold(BASH_TOOL('npm run build'), 3).done
    expect(r.ms).toBeGreaterThanOrEqual(2000)
  }, 15_000)
})
