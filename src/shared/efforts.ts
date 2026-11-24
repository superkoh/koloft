// CC§9
export const CRON_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type CronEffort = (typeof CRON_EFFORTS)[number]
export function isCronEffort(v: unknown): v is CronEffort {
  return (CRON_EFFORTS as readonly unknown[]).includes(v)
}
