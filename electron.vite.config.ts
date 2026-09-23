import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@renderer': resolve(__dirname, 'src/renderer/src')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    // three preloads, and they are not variants of each other: `index` is Koloft's own
    // privileged bridge for the host window, `guest` is the tiny dialog channel main
    // registers on the browser partition (§05D-11), `extAlias` is the `browser`→`chrome`
    // alias the extension platform registers on top of the upstream lib's preloads (D9).
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          guest: resolve(__dirname, 'src/preload/guest.ts'),
          extAlias: resolve(__dirname, 'src/preload/extAlias.ts')
        }
      }
    }
  },
  renderer: {
    resolve: { alias },
    plugins: [react()]
  }
})
