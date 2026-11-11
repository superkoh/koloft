import fs from 'fs'

const TASKPOLICY = '/usr/sbin/taskpolicy'

export function liftedWhen(taskpolicyIsThere: boolean, argv: string[]): string[] {
  return taskpolicyIsThere ? [TASKPOLICY, '-a', ...argv] : argv
}

let taskpolicyIsThere: boolean | undefined

// ADR-0042 PLATFORM§59
export function aboveItsTools(argv: string[]): string[] {
  taskpolicyIsThere ??= fs.existsSync(TASKPOLICY)
  return liftedWhen(taskpolicyIsThere, argv)
}
