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

function isScript(file: string): boolean {
  const head = Buffer.alloc(2)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, head, 0, 2, 0)
  } finally {
    fs.closeSync(fd)
  }
  return head.toString() === '#!'
}

function isRealGitProgram(file: string): boolean {
  try {
    const real = fs.realpathSync(file)
    return path.basename(real) === 'git' && isExecutableFile(real) && !isScript(real)
  } catch {
    return false
  }
}

// PLATFORM§1
export function theUsersGit(loginPath: string | undefined): string | undefined {
  return dirsAnotherGitMayBeIn(loginPath)
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, 'git'))
    .find(isRealGitProgram)
}

export function stepAsideForTheUsersGit(gitBinDir: string, loginPath: string | undefined): void {
  const theirs = theUsersGit(loginPath)
  if (theirs) writeExecutable(path.join(gitBinDir, 'git'), `#!/bin/sh\nexec ${shq(theirs)} "$@"\n`)
}

export function linkOrUnlink(link: string, target: string | undefined): void {
  try {
    fs.unlinkSync(link)
  } catch {}
  if (target) fs.symlinkSync(target, link)
}
