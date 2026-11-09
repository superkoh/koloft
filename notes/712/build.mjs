import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

await build({
  entryPoints: [join(here, 'gen.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: process.argv[2],
  packages: 'external',
  alias: { '@shared': join(root, 'src', 'shared') },
  logLevel: 'warning',
  plugins: [
    {
      name: 'raw',
      setup(b) {
        b.onResolve({ filter: /\?(raw|asset)$/ }, (a) => ({ path: a.path, namespace: 'raw' }))
        b.onLoad({ filter: /.*/, namespace: 'raw' }, () => ({ contents: '', loader: 'text' }))
      }
    }
  ]
})
