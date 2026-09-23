// markdown-it-footnote 4.x ships no declarations and has no @types package, so its default
// export is declared here rather than blunting the import with `any`.
// The renderer project gets `*.css` module declarations from vite/client; the test project
// does not load those types but still typechecks this file, and the pipeline imports the
// KaTeX stylesheet lazily (NFR-03).
declare module 'katex/dist/katex.min.css'

declare module 'markdown-it-footnote' {
  import type { MarkdownIt } from 'markdown-it'
  const footnotePlugin: (md: MarkdownIt) => void
  export default footnotePlugin
}
