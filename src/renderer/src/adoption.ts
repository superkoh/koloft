let resolveSettled: (() => void) | null = null
let settled = false

export const adoptionSettled: Promise<void> = new Promise((r) => {
  resolveSettled = r
})

export function markAdoptionSettled(): void {
  settled = true
  resolveSettled?.()
}

export function adoptionIsSettled(): boolean {
  return settled
}

export const preAdoptExits = new Set<string>()
