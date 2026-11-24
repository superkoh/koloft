export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
