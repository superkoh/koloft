export const BACKGROUND_LABEL_CHARS = 160

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60)
    const rem = Math.round(seconds % 60)
    return rem ? `${mins}m${rem}s` : `${mins}m`
  }
  const hrs = Math.floor(seconds / 3600)
  const mins = Math.round((seconds % 3600) / 60)
  return mins ? `${hrs}h${mins}m` : `${hrs}h`
}

export function scheduleLabel(when: { seconds?: number; cron?: string; prompt?: string }): string {
  const prompt = when.prompt?.replace(/\s+/g, ' ').trim()
  const cron = when.cron?.trim()
  const prefix =
    when.seconds !== undefined
      ? `Timer (${formatSeconds(when.seconds)})`
      : cron
        ? `Cron (${cron})`
        : 'Scheduled task'
  const text = prompt ? `${prefix}: ${prompt}` : prefix
  return text.slice(0, BACKGROUND_LABEL_CHARS)
}
