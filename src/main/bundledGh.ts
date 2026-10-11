import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { remoteShCommand } from './remote/install'

const GITHUB_CREDENTIAL_URLS = ['https://github.com', 'https://gist.github.com']

export function bundledGh(): string | null {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'gh', 'bin', 'gh')
    : path.join(__dirname, '..', '..', 'vendor', 'gh', 'bin', 'gh')
  return fs.existsSync(file) ? file : null
}

// PLATFORM§43
export function ghCredentialScript(gh: string): string {
  return `#!/bin/sh
[ "$1" = get ] || exit 0
request=$(cat)
case "$request" in
username=*|*"
username="*) exit 0 ;;
esac
printf '%s\\n\\n' "$request" | exec ${shq(gh)} auth git-credential get
`
}

// PLATFORM§43
export function gitCredentialEnv(env: NodeJS.ProcessEnv, helper: string): Record<string, string> {
  const given = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10)
  const first = Number.isInteger(given) && given > 0 ? given : 0
  const vars: Record<string, string> = {
    GIT_CONFIG_COUNT: String(first + GITHUB_CREDENTIAL_URLS.length)
  }
  GITHUB_CREDENTIAL_URLS.forEach((url, i) => {
    vars[`GIT_CONFIG_KEY_${first + i}`] = `credential.${url}.helper`
    vars[`GIT_CONFIG_VALUE_${first + i}`] = `!${shq(helper)}`
  })
  return vars
}

// PLATFORM§43
const GH_SIGN_IN = 'GH_PROMPT_DISABLED=1 gh auth login --web -h github.com --clipboard=false'

export const GH_SIGN_IN_LINE = `${GH_SIGN_IN} && exit`

export function remoteGhSignInLine(host: string, sshOptions: string[]): string {
  return `ssh -t ${sshOptions.join(' ')} ${shq(host)} ${shq(remoteShCommand(GH_SIGN_IN))} && exit`
}

export function pathWithDirLast(pathVar: string | undefined, dir: string): string {
  const dirs = (pathVar ?? '').split(':').filter(Boolean)
  return (dirs.includes(dir) ? dirs : [...dirs, dir]).join(':')
}

export function setupBundledGh(commandsBin: string): string | null {
  const gh = bundledGh()
  if (!gh) return null
  const link = path.join(commandsBin, 'gh')
  fs.rmSync(link, { force: true })
  fs.symlinkSync(gh, link)
  const helper = path.join(path.dirname(commandsBin), 'gh-credential')
  fs.writeFileSync(helper, ghCredentialScript(gh), { mode: 0o755 })
  fs.chmodSync(helper, 0o755)
  return helper
}
