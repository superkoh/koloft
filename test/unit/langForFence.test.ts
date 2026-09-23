import { describe, it, expect } from 'vitest'
import { langForFence } from '../../src/renderer/src/highlight'

const GRAMMARS_HIGHLIGHT_TS_LOADS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'shellscript',
  'python',
  'rust',
  'go',
  'css',
  'html',
  'markdown',
  'yaml',
  'toml',
  'sql',
  'c',
  'cpp',
  'java',
  'ruby',
  'php',
  'vue',
  'svelte',
  'docker',
  'diff',
  'makefile'
]

describe('langForFence', () => {
  it('maps the short names md writers actually type', () => {
    expect(langForFence('bash')).toBe('shellscript')
    expect(langForFence('sh')).toBe('shellscript')
    expect(langForFence('zsh')).toBe('shellscript')
    expect(langForFence('shell')).toBe('shellscript')
    expect(langForFence('js')).toBe('javascript')
    expect(langForFence('ts')).toBe('typescript')
    expect(langForFence('py')).toBe('python')
    expect(langForFence('rb')).toBe('ruby')
    expect(langForFence('yml')).toBe('yaml')
    expect(langForFence('Dockerfile')).toBe('docker')
    expect(langForFence('patch')).toBe('diff')
  })

  it('passes through a name that is already the grammar name', () => {
    expect(langForFence('typescript')).toBe('typescript')
    expect(langForFence('python')).toBe('python')
    expect(langForFence('diff')).toBe('diff')
    expect(langForFence('svelte')).toBe('svelte')
  })

  it('is case-insensitive, the way GitHub fences are', () => {
    expect(langForFence('JS')).toBe('javascript')
    expect(langForFence('Python')).toBe('python')
    expect(langForFence('YAML')).toBe('yaml')
  })

  it('reads only the language name out of a decorated fence info string', () => {
    expect(langForFence('ts twoslash')).toBe('typescript')
    expect(langForFence('js {1,3}')).toBe('javascript')
    expect(langForFence('bash title="run it"')).toBe('shellscript')
    expect(langForFence('  py  ')).toBe('python')
  })

  it('falls back to plain text instead of erroring on an unloaded language', () => {
    expect(langForFence('elixir')).toBe('text')
    expect(langForFence('plantuml')).toBe('text')
    expect(langForFence('')).toBe('text')
    expect(langForFence('   ')).toBe('text')
  })

  it('does not claim mermaid — the caller intercepts that fence before highlighting', () => {
    expect(langForFence('mermaid')).toBe('text')
  })

  it('never names a grammar that is not loaded', () => {
    const fences = [
      'bash',
      'sh',
      'zsh',
      'shell',
      'console',
      'js',
      'jsx',
      'ts',
      'tsx',
      'mjs',
      'cjs',
      'py',
      'python3',
      'rb',
      'yml',
      'yaml',
      'json',
      'jsonc',
      'toml',
      'sql',
      'rs',
      'golang',
      'c',
      'h',
      'cpp',
      'c++',
      'hpp',
      'java',
      'kotlin',
      'php',
      'css',
      'scss',
      'html',
      'xml',
      'vue',
      'svelte',
      'dockerfile',
      'docker',
      'patch',
      'diff',
      'make',
      'makefile',
      'md',
      'markdown',
      'text',
      'txt',
      'elixir',
      'mermaid'
    ]
    for (const f of fences) {
      const lang = langForFence(f)
      expect([...GRAMMARS_HIGHLIGHT_TS_LOADS, 'text'], `fence \`${f}\` -> ${lang}`).toContain(lang)
    }
  })
})
