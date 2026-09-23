import fs from 'fs'
import os from 'os'
import path from 'path'
import { expect, it, onTestFinished } from 'vitest'
import { probeClaude } from '../../src/main/claudeProbe'

// The native installer adds ~/.local/bin to PATH in ~/.zshrc, which only an interactive
// shell reads — the same shell a session runs in, so "not installed" must not be said
// of a claude that every session then finds.
it('finds a claude whose PATH entry lives in .zshrc alone', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-claude-probe-'))
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, 'bin'))
  fs.writeFileSync(path.join(directory, 'bin', 'claude'), '#!/bin/sh\n', { mode: 0o700 })
  fs.writeFileSync(path.join(directory, '.zshrc'), 'export PATH="$ZDOTDIR/bin:$PATH"\n')
  const result = await probeClaude({ PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', ZDOTDIR: directory })
  expect(result).toEqual({ found: true })
})
