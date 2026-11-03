import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@renderer': resolve(__dirname, 'src/renderer/src')
}

const license = { fileName: '.vite/license.json' }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { license },
    resolve: {
      alias: {
        ...alias,
        // PLATFORM§21
        '@xterm/headless': resolve(
          __dirname,
          'node_modules/@xterm/headless/lib-headless/xterm-headless.mjs'
        )
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      license,
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
    build: { license },
    plugins: [react()]
  }
})
