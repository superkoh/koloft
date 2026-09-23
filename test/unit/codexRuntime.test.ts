import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCodexRuntime } from '../../src/main/codexRuntime'
import { PtyManager } from '../../src/main/ptyManager'

const fake = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: fake.spawn }))

let directory: string
let binary: string
let environment: NodeJS.ProcessEnv

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-codex-runtime-'))
  const bin = path.join(directory, 'bin')
  fs.mkdirSync(bin)
  binary = path.join(bin, 'codex')
  fs.writeFileSync(binary, '#!/bin/sh\nprintf "codex-cli 0.153.4\\n"\n', { mode: 0o700 })
  environment = {
    PATH: '/usr/bin:/bin',
    SHELL: '/bin/zsh',
    ZDOTDIR: directory,
    CODEX_THREAD_ID: 'parent-thread',
    CODEX_CUSTOM_OPTION: 'normal-config',
    OPENAI_API_KEY: 'inherited-fixture-key'
  }
  fs.writeFileSync(
    path.join(directory, '.zprofile'),
    'printf "profile banner\\n"\nexport CODEX_HOME="$ZDOTDIR/codex home"\n'
  )
  fs.writeFileSync(
    path.join(directory, '.zshrc'),
    'printf "interactive banner\\n"\nexport PATH="$ZDOTDIR/bin:$PATH"\nexport OPENAI_API_KEY="profile-fixture-key"\nexport NORMAL_MULTILINE="first\nsecond=part"\n'
  )
  fake.spawn.mockReturnValue({ onData: vi.fn(), onExit: vi.fn(), pid: 123, process: 'codex' })
})

afterEach(() => {
  vi.clearAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('Codex shell runtime', () => {
  it('loads login and interactive configuration while excluding profile noise and runtime markers', async () => {
    const runtime = await resolveCodexRuntime({ env: environment })
    expect(runtime.binary).toBe(binary)
    expect(runtime.version).toBe('0.153.4')
    expect(runtime.env.CODEX_HOME).toBe(path.join(directory, 'codex home'))
    expect(runtime.env.OPENAI_API_KEY).toBe('profile-fixture-key')
    expect(runtime.env.CODEX_CUSTOM_OPTION).toBe('normal-config')
    expect(runtime.env.NORMAL_MULTILINE).toBe('first\nsecond=part')
    expect(runtime.env.CODEX_THREAD_ID).toBeUndefined()
  })

  it('does not resurrect an inherited credential explicitly unset by the user profile', async () => {
    fs.appendFileSync(path.join(directory, '.zshrc'), '\nunset OPENAI_API_KEY\n')
    const runtime = await resolveCodexRuntime({ env: environment })
    expect(runtime.env.OPENAI_API_KEY).toBeUndefined()
  })

  it('returns static errors without profile stdout, stderr, or credentials', async () => {
    fs.writeFileSync(
      path.join(directory, '.zshrc'),
      'printf "fixture-private-stdout\\n"\nprintf "fixture-private-stderr\\n" >&2\nexit 42\n'
    )
    let failure: unknown
    try {
      await resolveCodexRuntime({ env: environment })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain('fixture-private')
    expect(Object.keys(failure as object)).toEqual([])
  })

  it('uses the guarded fixture binary without executing profiles', async () => {
    fs.writeFileSync(path.join(directory, '.zshrc'), 'exit 42\n')
    const runtime = await resolveCodexRuntime({
      env: { ...environment, KOLOFT_TEST_BACKGROUND: '1', KOLOFT_CODEX_CMD: binary },
      shell: '/missing-shell'
    })
    expect(runtime.binary).toBe(binary)
    expect(runtime.env.OPENAI_API_KEY).toBe('inherited-fixture-key')
    expect(runtime.env.KOLOFT_CODEX_CMD).toBeUndefined()
  })

  it('does not expose invalid version output in user-facing errors', async () => {
    fs.writeFileSync(binary, '#!/bin/sh\nprintf "fixture-private-version-output\\n"\n', {
      mode: 0o700
    })
    await expect(resolveCodexRuntime({ env: environment })).rejects.toThrow('did not report')
    await expect(resolveCodexRuntime({ env: environment })).rejects.not.toThrow('fixture-private')
  })

  it.each([
    { printed: '0.153.3', runs: false, verified: false },
    { printed: '0.153.4', runs: true, verified: true },
    { printed: '0.154.0', runs: true, verified: false }
  ])('runs Codex $printed: $runs (verified $verified)', async ({ printed, runs, verified }) => {
    fs.writeFileSync(binary, `#!/bin/sh\nprintf "codex-cli ${printed}\\n"\n`, { mode: 0o700 })
    if (!runs) {
      await expect(resolveCodexRuntime({ env: environment })).rejects.toThrow(
        'Codex CLI 0.153.4 or newer'
      )
      return
    }
    await expect(resolveCodexRuntime({ env: environment })).resolves.toMatchObject({
      version: printed,
      verified
    })
  })

  it('passes the same resolved user configuration to the native PTY without Claude integration', async () => {
    const runtime = await resolveCodexRuntime({ env: environment })
    const manager = new PtyManager()
    manager.shimDir = '/must-not-prepend'
    manager.regDir = '/must-not-register'
    manager.pickDir = '/must-not-pick'
    manager.cdpDir = '/must-not-browse'
    manager.makeHookSettings = vi.fn(() => '/must-not-hook')
    manager.multiAccountOn = vi.fn(() => true)
    manager.create({
      kind: 'codex',
      cwd: directory,
      executable: runtime.binary,
      argv: ['--remote', 'unix:///test/socket'],
      processEnv: runtime.env
    })
    const [executable, args, options] = fake.spawn.mock.lastCall!
    expect(executable).toBe(binary)
    expect(args).toEqual(['--remote', 'unix:///test/socket'])
    expect(options.env.PATH).toBe(runtime.env.PATH)
    expect(options.env.CODEX_HOME).toBe(runtime.env.CODEX_HOME)
    expect(options.env.CODEX_CUSTOM_OPTION).toBe('normal-config')
    expect(options.env.OPENAI_API_KEY).toBe('profile-fixture-key')
    expect(Object.keys(options.env).some((key) => key.startsWith('KOLOFT_'))).toBe(false)
    expect(options.env.CODEX_THREAD_ID).toBeUndefined()
    expect(manager.makeHookSettings).not.toHaveBeenCalled()
    expect(manager.multiAccountOn).not.toHaveBeenCalled()
  })
})
