import { app } from 'electron'
import fs from 'fs'
import path from 'path'

export function bundledGh(): string | null {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'gh', 'bin', 'gh')
    : path.join(__dirname, '..', '..', 'vendor', 'gh', 'bin', 'gh')
  return fs.existsSync(file) ? file : null
}

export function pathWithDirLast(pathVar: string | undefined, dir: string): string {
  return [...(pathVar ?? '').split(':').filter((d) => d && d !== dir), dir].join(':')
}

export function setupBundledGh(installDir: string): string | null {
  const gh = bundledGh()
  if (!gh) return null
  const dir = path.join(installDir, 'fallback-bin')
  fs.mkdirSync(dir, { recursive: true })
  const link = path.join(dir, 'gh')
  fs.rmSync(link, { force: true })
  fs.symlinkSync(gh, link)
  return dir
}
