import path from 'path'
import { createJiti } from 'jiti'

const src = path.join(import.meta.dirname, '..', '..', 'src')
const jiti = createJiti(import.meta.url, {
  alias: {
    '@shared': path.join(src, 'shared'),
    '@core': path.join(src, 'core'),
    '@plugins': path.join(src, 'plugins')
  }
})
await jiti.import('./sandbox.ts')
