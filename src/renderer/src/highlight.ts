// PLATFORM§26
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { extOf, basename } from '@shared/preview'

const THEME = 'github-dark'
const THEME_LIGHT = 'github-light'

const LANGS = [
  () => import('@shikijs/langs/typescript'),
  () => import('@shikijs/langs/tsx'),
  () => import('@shikijs/langs/javascript'),
  () => import('@shikijs/langs/jsx'),
  () => import('@shikijs/langs/json'),
  () => import('@shikijs/langs/shellscript'),
  () => import('@shikijs/langs/python'),
  () => import('@shikijs/langs/rust'),
  () => import('@shikijs/langs/go'),
  () => import('@shikijs/langs/css'),
  () => import('@shikijs/langs/html'),
  () => import('@shikijs/langs/markdown'),
  () => import('@shikijs/langs/yaml'),
  () => import('@shikijs/langs/toml'),
  () => import('@shikijs/langs/sql'),
  () => import('@shikijs/langs/c'),
  () => import('@shikijs/langs/cpp'),
  () => import('@shikijs/langs/java'),
  () => import('@shikijs/langs/ruby'),
  () => import('@shikijs/langs/php'),
  () => import('@shikijs/langs/vue'),
  () => import('@shikijs/langs/svelte'),
  () => import('@shikijs/langs/docker'),
  () => import('@shikijs/langs/diff'),
  () => import('@shikijs/langs/makefile')
]

const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.py': 'python',
  '.pyi': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.css': 'css',
  '.scss': 'css',
  '.less': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sql': 'sql',
  '.c': 'c',
  '.h': 'cpp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.java': 'java',
  '.kt': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.zsh': 'shellscript',
  '.fish': 'shellscript',
  '.diff': 'diff',
  '.patch': 'diff',
  '.dockerfile': 'docker',
  '.mk': 'makefile',
  '.makefile': 'makefile'
}

const BASENAME_LANG: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'makefile',
  gnumakefile: 'makefile'
}

const FENCE_LANG: Record<string, string> = {
  ts: 'typescript',
  typescript: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  json: 'json',
  jsonc: 'json',
  bash: 'shellscript',
  sh: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  shellscript: 'shellscript',
  py: 'python',
  python: 'python',
  python3: 'python',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  golang: 'go',
  css: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  java: 'java',
  rb: 'ruby',
  ruby: 'ruby',
  php: 'php',
  vue: 'vue',
  svelte: 'svelte',
  dockerfile: 'docker',
  docker: 'docker',
  diff: 'diff',
  patch: 'diff',
  make: 'makefile',
  makefile: 'makefile',
  mk: 'makefile',
  text: 'text',
  txt: 'text',
  plain: 'text',
  plaintext: 'text'
}

export function langForFence(info: string): string {
  const name = info
    .trim()
    .toLowerCase()
    .split(/[\s{,:]/, 1)[0]
  return FENCE_LANG[name] ?? 'text'
}

export function langForPath(p: string): string {
  const base = basename(p).toLowerCase()
  if (BASENAME_LANG[base]) return BASENAME_LANG[base]
  return EXT_LANG[extOf(p)] ?? 'text'
}

let hlPromise: Promise<HighlighterCore> | null = null
function getHighlighter(): Promise<HighlighterCore> {
  return (hlPromise ??= createHighlighterCore({
    themes: [
      () => import('@shikijs/themes/github-dark'),
      () => import('@shikijs/themes/github-light')
    ],
    langs: LANGS,
    // PLATFORM§26
    engine: createJavaScriptRegexEngine()
  }))
}

export async function highlightCode(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter()
  const resolved = hl.getLoadedLanguages().includes(lang) ? lang : 'text'
  return hl.codeToHtml(code, { lang: resolved, theme: THEME })
}

export async function highlightCodeLight(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter()
  const resolved = hl.getLoadedLanguages().includes(lang) ? lang : 'text'
  return hl.codeToHtml(code, { lang: resolved, theme: THEME_LIGHT })
}

const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => HTML_ESC[c])
}

const SHIKI_FONT_ITALIC = 1
const SHIKI_FONT_BOLD = 2
const SHIKI_FONT_UNDERLINE = 4

function tokenStyle(color: string | undefined, fontStyle: number | undefined): string {
  let s = color ? `color:${color}` : ''
  if (fontStyle) {
    if (fontStyle & SHIKI_FONT_ITALIC) s += ';font-style:italic'
    if (fontStyle & SHIKI_FONT_BOLD) s += ';font-weight:bold'
    if (fontStyle & SHIKI_FONT_UNDERLINE) s += ';text-decoration:underline'
  }
  return s
}

export async function highlightLines(code: string, lang: string): Promise<string[]> {
  const hl = await getHighlighter()
  const resolved = hl.getLoadedLanguages().includes(lang) ? lang : 'text'
  const { tokens } = hl.codeToTokens(code, { lang: resolved, theme: THEME })
  return tokens.map((line) =>
    line
      .map((t) => {
        const style = tokenStyle(t.color, t.fontStyle)
        const text = escapeHtml(t.content)
        return style ? `<span style="${style}">${text}</span>` : text
      })
      .join('')
  )
}
