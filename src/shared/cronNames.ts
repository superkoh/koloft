/** Names a scheduled job's run folder. Shared, not main-only: the renderer
 *  shows the same slug in the form's "Where it runs" note while you type, so the
 *  folder you are promised is the folder you get.
 *
 *  The 48-char cut plus the 12-char `-yymmdd-HHMM` stamp (and at most a `-99` or
 *  `-abcd` suffix) keeps the result inside isValidWorktreeName's 64-char limit,
 *  which is what a git branch name must survive. */

/** lowercase; every run of characters outside [a-z0-9] becomes one '-'; ends
 *  trimmed of '-'; cut to 48. Never empty — 'job' when nothing is left. */
export function slugOf(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return s || 'job'
}

/** The form and the loader use THIS, not slugOf, to reject a name like "!!!":
 *  slugOf would happily answer 'job' for it and hide the mistake. */
export function hasWordChar(name: string): boolean {
  return /[A-Za-z0-9]/.test(name)
}

/** A model name the launch line can carry: `--model <this>` is typed into a login
 *  shell, so only a plain token is allowed. ONE rule for the form, the save, the
 *  loader and the launch — four copies once drifted apart in spirit, and a model that
 *  passes the save but fails the launch shows up as "Claude exited before it started". */
export function isValidModelName(model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,80}$/.test(model)
}

/** `<slug>-yymmdd-HHMM`, in the LOCAL time of `dueAt` — the folder name has to
 *  match the clock on the wall the person read the schedule off. */
export function worktreeBase(job: { name: string }, dueAt: number): string {
  const d = new Date(dueAt)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${p2(d.getFullYear() % 100)}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`
  return `${slugOf(job.name)}-${stamp}`
}
