import path from 'path'
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url, {
  alias: { '@shared': path.join(import.meta.dirname, '..', '..', 'src', 'shared') }
})
await jiti.import('./sandbox.ts')
