import type { TextBlock } from '@core/plugin'
import { SESSION_BACKENDS } from '@shared/sessionBackend'

export const TEXT: readonly TextBlock[] = [
  { slot: 'koloft-skill-cron', text: 'list, add, change or run scheduled tasks, ' },
  {
    slot: 'koloft-help-rule-cron',
    text: `
3. Scheduled tasks: before you add or change one, tell the owner how often it runs, what it does and which permission it gets. Before you remove one, run "koloft cron show" to be sure it is the right one.`
  },
  {
    slot: 'koloft-help-cron',
    text: `

SCHEDULED TASKS

A scheduled task (cron) is a job that starts a new session by itself on a timer. Name a task by its number from "koloft cron list" or by its name.

A task's name may have spaces: put it in quotes, like "Nightly tests". If you forget, Koloft still finds it: the words that stand together, with no option or -- between them, are the name.

Every cron command works on this session's workspace, or on the one --workspace <workspace> names (its folder name or full path). The butler has no workspace of its own, so it always gives --workspace.

When it runs: --every 30m, --every 2h, --daily 09:00, --weekly mon,wed,fri@09:00, --once 2026-10-25@14:00, or --after 2h
    --every runs on the clock: every 2h is 0:00, 2:00, 4:00 and so on.
    --once runs one time on that day at that time, then the task turns itself off.
    --after waits that long after each run's tab is gone, then starts the next run. The wait also starts again when the task is saved or turned on.
Options: --backend ${SESSION_BACKENDS.join('|')}, --model <model>, --effort low|medium|high|xhigh|max, --permission same|acceptEdits|skipAll, --when-done open|close
    same (the default): the same permission as a session started from the sidebar's + button. With Skip permission prompts off in Settings ▸ Accounts, a run then waits on each ask until someone answers.
    acceptEdits: may change files without asking.
    skipAll: never asks for permission.
    --when-done close: once the run has finished all its work, its tab, its sidebar row and its worktree go, so the next run is not skipped. A run that asks something, still has work running, or would lose a change or a commit stays open. The default, open, leaves it open for you.

koloft cron list
    List this workspace's tasks: number, name, when it runs, on or off, next run, last result.

koloft cron show <number or name>
    Show one task in full: what it does, model, permission, recent runs.
    Example: koloft cron show 2

koloft cron add --name <name> <when it runs> [options] -- "<what to do>"
    Add a task.
    Example: koloft cron add --name "Nightly tests" --daily 02:00 --permission acceptEdits -- "Run the tests and write a short report."

koloft cron edit <number or name> [when it runs] [options] [-- "<what to do>"]
    Change a task. Only the parts you give change.
    Example: koloft cron edit "Nightly tests" --daily 03:00

koloft cron rm <number or name>
    Remove a task.
    Example: koloft cron rm "Nightly tests"

koloft cron on <number or name>
koloft cron off <number or name>
    Turn a task on or off.
    Example: koloft cron off 2

koloft cron run <number or name>
    Run a task once, right now.
    Example: koloft cron run "Nightly tests"`
  }
]
