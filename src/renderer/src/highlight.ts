import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { extOf, basename } from '@shared/preview'

const THEME = 'github-dark'
// The md preview is a light paper sheet (NFR-07); the code view and the inline diff stay
// on THEME. Both themes live in one highlighter so the grammars are parsed once.
const THEME_LIGHT = 'github-light'

// A broad-but-bounded language set, loaded once at module scope. `shellscript` covers
// bash/sh/zsh, `docker` covers Dockerfile, `diff` covers patches, `makefile` covers
// Makefiles. Anything outside this set falls back to `text` (escaped, unstyled) — no
// grammar needs to be loaded for the bypass.
// Fine-grained imports (shiki/core): only these grammars reach the bundle. The `shiki`
// main entry registers every bundled language as a lazy chunk, so vite emits ~280
// grammar files (~8 MB) plus the oniguruma wasm into out/renderer even though none of
// them ever load at runtime.
// Thunks, not bare import() calls: grammars still only load on first highlight.
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

// Files with no extension but a conventional basename.
const BASENAME_LANG: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'makefile',
  gnumakefile: 'makefile'
}

// Fence language names as md writers type them → the grammars LANGS loads. TRUE aliases
// only: a near-miss grammar (kotlin under java, scss under css, xml under html) colours
// the wrong words and reads as a bug, which is worse than the plain text FR-05 asks for —
// anything not listed here resolves to `text` on purpose (FR-05 / Edge Cases #7).
// `mermaid` is deliberately absent — the preview intercepts that fence before shiki.
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

/** Resolve a fence info string (` ```bash `, ` ```ts twoslash `) to a loaded shiki
 *  language. Unknown languages resolve to `text` rather than throwing. */
export function langForFence(info: string): string {
  // the info string carries more than the language: "ts twoslash", "js {1,3}",
  // `bash title="…"` — only the leading token names the grammar.
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
  // JS regex engine (no oniguruma wasm) — pure JS, no Node polyfill, no dynamic wasm
  // import; all built-in languages are supported by it since shiki 3.9.1. Inited once.
  return (hlPromise ??= createHighlighterCore({
    themes: [
      () => import('@shikijs/themes/github-dark'),
      () => import('@shikijs/themes/github-light')
    ],
    langs: LANGS,
    engine: createJavaScriptRegexEngine()
  }))
}

/** Highlight `code` to Shiki's themed `<pre><code>` HTML. An unloaded lang falls back
 *  to `text` (escaped plain text). */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter()
  const resolved = hl.getLoadedLanguages().includes(lang) ? lang : 'text'
  return hl.codeToHtml(code, { lang: resolved, theme: THEME })
}

/** `highlightCode` on the light theme, for the md preview's code fences. */
export async function highlightCodeLight(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter()
  const resolved = hl.getLoadedLanguages().includes(lang) ? lang : 'text'
  return hl.codeToHtml(code, { lang: resolved, theme: THEME_LIGHT })
}

const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => HTML_ESC[c])
}

// Shiki's FontStyle bitmask (shiki/textmate): 1 italic, 2 bold, 4 underline.
function tokenStyle(color: string | undefined, fontStyle: number | undefined): string {
  let s = color ? `color:${color}` : ''
  if (fontStyle) {
    if (fontStyle & 1) s += ';font-style:italic'
    if (fontStyle & 2) s += ';font-weight:bold'
    if (fontStyle & 4) s += ';text-decoration:underline'
  }
  return s
}

/** Highlight `code` to **one HTML string per source line** (not a `<pre>` blob), so a caller
 *  can interleave lines with its own row chrome — the inline diff view composes add/del/context
 *  rows from these. Token text is HTML-escaped as spans are built, so file content can never
 *  inject markup (same safety guarantee as `highlightCode`'s Shiki-escaped output). An unloaded
 *  lang falls back to `text`. The returned array length equals the source line count. */
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
