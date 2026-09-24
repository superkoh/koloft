import fs from 'fs'
import { dirExists, listDir, search, searchContent } from '../fileTree'
import { watchFile, unwatchFile, watchDir, unwatchDir } from '../fileWatch'
import { MAX_READ_BYTES, createFile, looksBinary, openForEdit, writeText } from '../fileEdit'
import {
  diffBase,
  gitStatus,
  gitNumstat,
  gitDiff,
  gitFileDiff,
  gitFileDiffFull
} from '../gitStatus'
import type { GithubLookup } from '../github'
import { resolveSpawnCwd } from '../projectInfo'
import type { Host } from './host'

async function readText(p: string): Promise<string> {
  const st = await fs.promises.stat(p).catch(() => {
    throw new Error('KOLOFT_READ_FAILED')
  })
  if (!st.isFile()) throw new Error('KOLOFT_NOT_FILE')
  if (st.size > MAX_READ_BYTES) throw new Error('KOLOFT_TOO_LARGE')
  const buf = await fs.promises.readFile(p).catch(() => {
    throw new Error('KOLOFT_READ_FAILED')
  })
  if (looksBinary(buf)) throw new Error('KOLOFT_BINARY')
  return buf.toString('utf8')
}

export function localHost(github: GithubLookup): Host {
  return {
    listDir,
    dirExists,
    search,
    searchContent,
    diffBase,
    gitStatus,
    gitNumstat,
    gitDiff,
    gitFileDiff,
    gitFileDiffFull,
    readText,
    openForEdit: async (p) => openForEdit(p),
    writeText: async (p, text, expect, opts) => writeText(p, text, expect, opts),
    createFile: async (dir, name) => createFile(dir, name),
    watchDir,
    unwatchDir,
    watchFile: (p, onChange) =>
      watchFile(p, (fp, st) => onChange(fp, { mtimeMs: st.mtimeMs, size: st.size })),
    unwatchFile,
    shell: (cwd) => {
      const spawnCwd = resolveSpawnCwd(cwd)
      return { spawnCwd, cwd: spawnCwd }
    },
    github
  }
}
