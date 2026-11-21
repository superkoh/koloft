interface Slot {
  run: Promise<unknown>
  trailing: Promise<unknown> | null
}

const slots = new Map<string, Slot>()

export function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const again = (): Promise<T> => {
    slots.delete(key)
    return coalesce(key, fn)
  }
  const slot = slots.get(key)
  if (slot) return (slot.trailing ??= slot.run.then(again, again)) as Promise<T>
  const fresh: Slot = {
    trailing: null,
    run: fn().finally(() => {
      if (!fresh.trailing) slots.delete(key)
    })
  }
  slots.set(key, fresh)
  return fresh.run as Promise<T>
}
