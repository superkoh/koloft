import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { commandLineToolsMissingNow, dirsAnotherGitMayBeIn } from './commandLineTools'

export function bundledGitRoot(): string | null {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'git')
    : path.join(__dirname, '..', '..', 'vendor', 'git')
  return fs.existsSync(path.join(root, 'libexec', 'git-core', 'git')) ? root : null
}

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export function anotherGitIn(dirs: string[]): boolean {
  return dirs.some((dir) => isExecutableFile(path.join(dir, 'git')))
}

const gitConfigString = (value: string): string =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

// PLATFORM§44
export function gitSystemConfig(root: string): string {
  return `[include]
\tpath = /etc/gitconfig
[init]
\tdefaultBranch = main
\ttemplateDir = ${gitConfigString(path.join(root, 'share', 'git-core', 'templates'))}
`
}

// PLATFORM§44
export function gitLauncherScript(root: string, systemConfig: string): string {
  const core = path.join(root, 'libexec', 'git-core')
  return `#!/bin/sh
export GIT_EXEC_PATH=${shq(core)}
export GIT_CONFIG_SYSTEM=${shq(systemConfig)}
exec ${shq(path.join(core, 'git'))} "$@"
`
}

export function gitMissing(pathVar: string | undefined): boolean {
  return commandLineToolsMissingNow() && !anotherGitIn(dirsAnotherGitMayBeIn(pathVar))
}

export function setupBundledGit(installDir: string): string | null {
  const root = bundledGitRoot()
  if (!root) return null
  const dir = path.join(installDir, 'git-bin')
  fs.mkdirSync(dir, { recursive: true })
  const config = path.join(installDir, 'gitconfig')
  fs.writeFileSync(config, gitSystemConfig(root))
  const launcher = path.join(dir, 'git')
  fs.writeFileSync(launcher, gitLauncherScript(root, config), { mode: 0o755 })
  fs.chmodSync(launcher, 0o755)
  return dir
}

export function pathWithDirFirst(pathVar: string | undefined, dir: string): string {
  return [dir, ...(pathVar ?? '').split(':').filter((d) => d && d !== dir)].join(':')
}
