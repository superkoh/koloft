import { sharedProcessTable } from '../../../main/processTable'
import { MACOS_PID_AT_MOST_FIVE_DIGITS, orphansByLaunchd, pidAlive } from '../../../main/leftovers'

const WAIT_FOR_LEFTOVER_EXIT_MS = 3000
const LEFTOVER_EXIT_POLL_MS = 100

// CODEX§5
export async function endCodexAppServersLeftByACrash(marker: string): Promise<void> {
  const leftovers = [...orphansByLaunchd(await sharedProcessTable.fresh())]
    .filter(([, command]) => command.includes('app-server --stdio') && command.includes(marker))
    .map(([pid]) => pid)
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  const until = Date.now() + WAIT_FOR_LEFTOVER_EXIT_MS
  while (leftovers.some(pidAlive) && Date.now() < until)
    await new Promise((r) => setTimeout(r, LEFTOVER_EXIT_POLL_MS))
}

export const CODEX_TMP_FOLDER = new RegExp(
  `^koloft-cx-(?:open-)?(${MACOS_PID_AT_MOST_FIVE_DIGITS})-`
)
