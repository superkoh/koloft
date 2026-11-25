import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { barePath } from '@shared/remoteKey'
import { gitIgnoredAmong } from './gitIgnored'

const execFileAsync = promisify(execFile)

export interface ScriptRunner {
  runScript(script: string, args: string[]): Promise<string | null>
}

export interface TreeIo {
  git(cwd: string, args: string[]): Promise<string>
  exists(p: string): Promise<boolean>
  real(p: string): string
  keyed(listed: string): string
  machine: ScriptRunner | undefined
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 4 * 1024 * 1024 })
  return result.stdout.trimEnd()
}

export const TREE_IO_ON_THIS_MAC: TreeIo = {
  git,
  exists: async (p) => fs.existsSync(p),
  real: (p) => fs.realpathSync(p),
  keyed: (listed) => path.resolve(listed),
  machine: undefined
}

const COPY_INCLUDES_SH = `root=$1 tree=$2
[ -f "$root/.worktreeinclude" ] || exit 0
git -C "$root" ls-files -z --others --ignored --exclude-from="$root/.worktreeinclude" |
  git -C "$root" check-ignore -z --stdin |
  xargs -0 sh -c 'root=$1 tree=$2; shift 2
for rel do
  [ -f "$root/$rel" ] && [ ! -L "$root/$rel" ] && [ ! -e "$tree/$rel" ] || continue
  mkdir -p "$(dirname "$tree/$rel")" && cp "$root/$rel" "$tree/$rel" || exit 1
done' sh "$root" "$tree"`

// CC§3
export async function copyWorktreeIncludes(
  root: string,
  worktreePath: string,
  machine?: ScriptRunner
): Promise<void> {
  if (machine) {
    if (
      (await machine.runScript(COPY_INCLUDES_SH, [barePath(root), barePath(worktreePath)])) === null
    )
      console.error('[koloft] could not copy the .worktreeinclude files into', worktreePath)
    return
  }
  try {
    const includeFile = path.join(root, '.worktreeinclude')
    if (!fs.existsSync(includeFile)) return
    const listed = (
      await git(root, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${includeFile}`])
    )
      .split('\0')
      .filter(Boolean)
    if (!listed.length) return
    for (const rel of await gitIgnoredAmong(root, listed)) {
      const from = path.join(root, rel)
      const to = path.join(worktreePath, rel)
      if (!fs.lstatSync(from).isFile() || fs.existsSync(to)) continue
      await fs.promises.mkdir(path.dirname(to), { recursive: true })
      await fs.promises.copyFile(from, to)
    }
  } catch (error) {
    console.error('[koloft] could not copy the .worktreeinclude files into', worktreePath, error)
  }
}
