import { describe, it, expect } from 'vitest'
import { installThen, pathWithInstallDir } from '../../src/main/toolInstall'

// CC§10 CODEX§22 AGY§3
describe('installThen', () => {
  it('runs each agent’s official installer, then its program from the folder that installer fills', () => {
    const then = (binary: string): string => `exec ${binary} login`
    expect(installThen('claude', then)).toBe(
      'curl -fsSL https://claude.ai/install.sh | bash; [ -x "$HOME/.local/bin/claude" ] && exec "$HOME/.local/bin/claude" login'
    )
    expect(installThen('codex', then)).toBe(
      'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh; [ -x "$HOME/.local/bin/codex" ] && exec "$HOME/.local/bin/codex" login'
    )
    expect(installThen('agy', then)).toBe(
      'curl -fsSL https://antigravity.google/cli/install.sh | bash; [ -x "$HOME/.local/bin/agy" ] && exec "$HOME/.local/bin/agy" login'
    )
  })

  it('runs the test installer in its place, naming the program it then looks for', () => {
    expect(installThen('agy', () => 'exit', '/t/fake installer')).toBe(
      `'/t/fake installer' agy; [ -x "$HOME/.local/bin/agy" ] && exit`
    )
  })
})

// CC§10
describe('pathWithInstallDir', () => {
  it('puts the folder the official installers use at the end of a PATH that lacks it, once', () => {
    const once = pathWithInstallDir('/usr/bin:/bin', '/Users/me')
    expect(once).toBe('/usr/bin:/bin:/Users/me/.local/bin')
    expect(pathWithInstallDir(once, '/Users/me')).toBe(once)
  })

  it('leaves a PATH that already has it where the user put it', () => {
    expect(pathWithInstallDir('/Users/me/.local/bin:/usr/bin', '/Users/me')).toBe(
      '/Users/me/.local/bin:/usr/bin'
    )
  })
})
