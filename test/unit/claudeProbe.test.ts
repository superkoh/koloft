import fs from 'fs'
import os from 'os'
import path from 'path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { probeClaude } from '../../src/main/claudeProbe'

// CC§10
it('finds a claude whose PATH entry lives in .zshrc alone', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-claude-probe-'))
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, 'bin'))
  fs.writeFileSync(path.join(directory, 'bin', 'claude'), '#!/bin/sh\n', { mode: 0o700 })
  fs.writeFileSync(path.join(directory, '.zshrc'), 'export PATH="$ZDOTDIR/bin:$PATH"\n')
  const result = await probeClaude({ PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', ZDOTDIR: directory })
  expect(result).toEqual({ found: true })
})

async function freshProbe(): Promise<typeof probeClaude> {
  vi.resetModules()
  return (await import('../../src/main/claudeProbe')).probeClaude
}

function fakeShell(body: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-claude-probe-shell-'))
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }))
  const shell = path.join(directory, 'shell')
  fs.writeFileSync(shell, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  return shell
}

it('answers found:false when the shell exits with a number', async () => {
  const probe = await freshProbe()
  expect(await probe({ PATH: '/usr/bin:/bin', SHELL: fakeShell('exit 1') })).toEqual({
    found: false
  })
})

it('answers found:true when the shell could not start, and asks again later', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const probe = await freshProbe()
  const noShell = path.join(os.tmpdir(), 'koloft-no-such-shell', 'sh')
  expect(await probe({ PATH: '/usr/bin:/bin', SHELL: noShell })).toEqual({ found: true })
  const missing = { PATH: '/usr/bin:/bin', SHELL: fakeShell('exit 1') }
  expect(await probe(missing)).toEqual({ found: true })
  vi.advanceTimersByTime(60_000)
  expect(await probe(missing)).toEqual({ found: false })
})

it('answers found:true when the shell times out, since a hung profile says nothing about claude', async () => {
  const probe = await freshProbe()
  expect(await probe({ PATH: '/usr/bin:/bin', SHELL: fakeShell('exec sleep 30') })).toEqual({
    found: true
  })
}, 20_000)
