/**
 * Which hook reports a tab may act on.
 *
 * Koloft bakes a tabId into the hook command line of the per-tab `--settings` file, so
 * every report a claude writes carries that tab's id. Claude Code's `/fork` ("copy
 * this conversation into a new background session and keep working here") spawns the
 * copy as a child that INHERITS those settings — so the fork's SessionStart/SessionEnd
 * and its every prompt/stop/notify arrive stamped with the PARENT TAB's id. Acting on
 * them rebinds the tab to a background copy, adopts it into the sidebar, and (when the
 * copy stops, which exits with reason `prompt_input_exit`) unbinds the tab the user is
 * still typing in.
 *
 * The report's own session id is what settles it: a report is this tab's only when it
 * names the session the tab is currently driving.
 */
export interface HookReport {
  /** start | end | prompt | stop | notify */
  event?: string
  /** SessionStart only: startup | resume | clear | compact | fork */
  source?: string
  /** the session the report is about; absent on a claude too old to send it */
  sessionId?: string
  /** the tmux session a REMOTE claude runs in (`k-<session id>`, hooks.ts); empty
   *  for a local one. What a re-attached tab is matched by, since its id changed. */
  tmux?: string
}

export function ownsHookReport(report: HookReport, boundSessionId: string | undefined): boolean {
  // A SessionStart splits by what its source CLAIMS, because a legitimate one routinely
  // names a different session than the tab is on:
  //   - `clear` / `resume` / `startup` claim a SWITCH — the tab is meant to move to the
  //     new id, so the id disagreeing is the normal case and must not be held against it.
  //   - `compact` claims CONTINUITY — auto-compaction re-inits a session in place and
  //     never changes its id, so one naming another session is somebody else's, and a
  //     long-lived background copy compacting itself reports exactly that (source
  //     `compact`, not `fork`). Honouring it would rebind the tab to the copy.
  //   - anything else, including a start with no source at all, is treated as a
  //     continuity claim: an unknown future source gets the conservative branch, and a
  //     fork whose source failed to parse still cannot pass by naming a foreign session.
  if (report.event === 'start') {
    if (report.source === 'fork') return false
    if (report.source === 'clear' || report.source === 'resume' || report.source === 'startup') {
      return true
    }
    // fall through to the id check below — continuity has to prove it
  }
  // Everything else (end, prompt, stop, notify) carries no source, so the id is the
  // only thing that can tell the tab's own session from a background copy sharing its
  // hook settings. A report without one, or a tab not yet driving a session, has
  // nothing to compare — keep the pre-fix behaviour rather than drop the report.
  if (!report.sessionId || !boundSessionId) return true
  return report.sessionId === boundSessionId
}

/**
 * Skip a report whose file says exactly what it said last time.
 *
 * A remote tab's hook reports arrive by rsync into a mirror, and rsync re-lands the
 * whole folder every round. Even with `--inplace` an unchanged file may be touched;
 * the watcher then re-delivers the tab's last SessionStart, whose effect is to seed
 * 'waiting' — mid-turn that reads as a finished turn. Only a CHANGED file is news.
 */
export function makeDropDedupe(): (key: string, text: string) => boolean {
  const last = new Map<string, string>()
  return (key, text) => {
    if (last.get(key) === text) return false
    last.set(key, text)
    return true
  }
}
