import { app } from 'electron'
import path from 'path'

// CC§6
export interface StatusLineSetting {
  type: 'command'
  command: string
  padding: number
}

export interface StatuslinePaths {
  wrapper: string
  config: string
}

// PLATFORM§4
export function unpackedModulePath(...parts: string[]): string {
  const raw = path.resolve(__dirname, '..', '..', 'node_modules', ...parts)
  return app.isPackaged
    ? raw.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    : raw
}

export function bundlePath(): string {
  return unpackedModulePath('ccstatusline', 'dist', 'ccstatusline.js')
}

export const EXEC_MARKER = '# koloft-exec: '

export const compileCacheIn = (dir: string): string => path.join(dir, 'vcache')
