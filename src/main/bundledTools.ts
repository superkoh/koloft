import { app } from 'electron'
import { execFileSync } from 'child_process'
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

// PLATFORM§50
export function bundledGcm(): string | undefined {
  const bin = path.join(vendorPath('gcm'), 'git-credential-manager')
  return fs.existsSync(bin) ? bin : undefined
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

const A_GIT_ANSWERS_ITS_EXEC_PATH_WITHIN_MS = 5_000

function execPathOf(git: string): string | undefined {
  try {
    return execFileSync(git, ['--exec-path'], {
      encoding: 'utf8',
      timeout: A_GIT_ANSWERS_ITS_EXEC_PATH_WITHIN_MS
    }).trim()
  } catch {
    return undefined
  }
}

// PLATFORM§1
export function preferTheUsersGit(gitBinDir: string, pathVar: string | undefined): void {
  const launcher = path.join(gitBinDir, 'git')
  const shipped = execPathOf(launcher)
  const theirs = dirsAnotherGitMayBeIn(pathVar)
    .map((dir) => path.join(dir, 'git'))
    .find((git) => {
      if (!isExecutableFile(git)) return false
      const answer = execPathOf(git)
      return answer !== undefined && answer !== shipped
    })
  if (!theirs) return
  const next = `${launcher}.next`
  linkOrUnlink(next, theirs)
  fs.renameSync(next, launcher)
}

export function linkOrUnlink(link: string, target: string | undefined): void {
  try {
    fs.unlinkSync(link)
  } catch {}
  if (target) fs.symlinkSync(target, link)
}
