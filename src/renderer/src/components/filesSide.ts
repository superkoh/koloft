export const SIDE_WIDTH_DEFAULT = 230
export const SIDE_WIDTH_MIN = 150
export const SIDE_READ_MIN = 240
const KEY = 'koloft.files.sideWidth'
const COMFORTABLE_READING_SPEED_PX_PER_SEC = 60
const SHORTEST_SLIDE_SEC = 0.4

export function clampSideWidth(want: number, containerWidth: number): number {
  const max = Math.max(SIDE_WIDTH_MIN, containerWidth - SIDE_READ_MIN)
  return Math.round(Math.min(Math.max(SIDE_WIDTH_MIN, want), max))
}

export function readSideWidth(): number {
  try {
    const n = Number(localStorage.getItem(KEY))
    if (Number.isFinite(n) && n >= SIDE_WIDTH_MIN) return n
  } catch {}
  return SIDE_WIDTH_DEFAULT
}

export function storeSideWidth(w: number): void {
  try {
    localStorage.setItem(KEY, String(w))
  } catch {}
}

export function slideOffset(scrollWidth: number, clientWidth: number): number {
  return Math.min(0, clientWidth - scrollWidth)
}

// ADR-0015
export function installSlideOnHover(
  container: HTMLElement,
  rowSel: string,
  labelSel: string
): () => void {
  let active: HTMLElement | null = null
  const reset = (): void => {
    if (!active) return
    active.classList.remove('fs-slide')
    active.style.removeProperty('--fs-shift')
    active.style.removeProperty('--fs-dur')
    active = null
  }
  const clippedLabel = (row: HTMLElement): HTMLElement | null => {
    const candidates = row.matches(labelSel)
      ? [row]
      : (Array.from(row.querySelectorAll(labelSel)) as HTMLElement[])
    return candidates.find((c) => slideOffset(c.scrollWidth, c.clientWidth) < 0) ?? null
  }
  const onOver = (e: Event): void => {
    const t = e.target as Element | null
    const row = t?.closest?.(rowSel) as HTMLElement | null
    if (!row || !container.contains(row)) return
    if (active && row.contains(active) && active.classList.contains('fs-slide')) return
    reset()
    const label = clippedLabel(row)
    if (!label) return
    active = label
    const shift = slideOffset(label.scrollWidth, label.clientWidth)
    label.style.setProperty('--fs-shift', `${shift}px`)
    label.style.setProperty(
      '--fs-dur',
      `${Math.max(SHORTEST_SLIDE_SEC, -shift / COMFORTABLE_READING_SPEED_PX_PER_SEC)}s`
    )
    label.classList.add('fs-slide')
  }
  const onOut = (e: Event): void => {
    if (!active) return
    const to = (e as MouseEvent).relatedTarget as Element | null
    const row = active.closest(rowSel)
    if (row && to && row.contains(to)) return
    reset()
  }
  container.addEventListener('mouseover', onOver)
  container.addEventListener('mouseout', onOut)
  return () => {
    reset()
    container.removeEventListener('mouseover', onOver)
    container.removeEventListener('mouseout', onOut)
  }
}
