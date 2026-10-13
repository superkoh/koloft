import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { commandLineToolsMissing, dirsAnotherGitMayBeIn } from './commandLineTools'
import { writeExecutable } from './playwrightCli'

function vendorPath(name: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, '..', '..', 'vendor', name)
}

// PLATFORM§44
export function bundledGhDir(): string | undefined {
  const dir = path.join(vendorPath('gh'), 'bin')
  return fs.existsSync(path.join(dir, 'gh')) ? dir : undefined
}

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export function gitMissing(pathVar: string | undefined): boolean {
  return (
    !dirsAnotherGitMayBeIn(pathVar).some((dir) => isExecutableFile(path.join(dir, 'git'))) &&
    commandLineToolsMissing()
  )
}

const gitConfigString = (value: string): string =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

// PLATFORM§45
export function gitSystemConfig(root: string): string {
  return `[include]
\tpath = /etc/gitconfig
[init]
\tdefaultBranch = main
\ttemplateDir = ${gitConfigString(path.join(root, 'share', 'git-core', 'templates'))}
`
}

// PLATFORM§45
export function gitLauncherScript(root: string, systemConfig: string): string {
  const core = path.join(root, 'libexec', 'git-core')
  return `#!/bin/sh
export GIT_EXEC_PATH=${shq(core)}
export GIT_CONFIG_SYSTEM=${shq(systemConfig)}
exec ${shq(path.join(core, 'git'))} "$@"
`
}

export function setupBundledGit(
  installDir: string,
  pathVar: string | undefined
): string | undefined {
  const root = vendorPath('git')
  if (!fs.existsSync(path.join(root, 'libexec', 'git-core', 'git')) || !gitMissing(pathVar))
    return undefined
  const dir = path.join(installDir, 'git-bin')
  fs.mkdirSync(dir, { recursive: true })
  const config = path.join(installDir, 'gitconfig')
  fs.writeFileSync(config, gitSystemConfig(root))
  writeExecutable(path.join(dir, 'git'), gitLauncherScript(root, config))
  return dir
}

export function linkOrUnlink(link: string, target: string | undefined): void {
  try {
    fs.unlinkSync(link)
  } catch {}
  if (target) fs.symlinkSync(target, link)
}
