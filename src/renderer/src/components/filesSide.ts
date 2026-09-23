/**
 * The Files tab's LEFT column — its width, and the hover-slide that lets a name too long
 * for that width be read without a tooltip.
 *
 * Changes' list (`.cv-side`) and Browse's tree (`.fv-tree`) are two components, but to the
 * reader they are one column that happens to change contents with the half-switch, so
 * they share ONE width. It is a per-app convenience rather than a setting: nothing in main
 * needs it, and the panel's other conveniences (Browse's expansion, Recents) already live
 * in localStorage for the same reason.
 */

export const SIDE_WIDTH_DEFAULT = 230
export const SIDE_WIDTH_MIN = 150
/** what the reading column / diff stream must keep, whatever the drag asks for */
export const SIDE_READ_MIN = 240
const KEY = 'koloft.files.sideWidth'

/** Clamp a requested width into [min, container − reading-column minimum]. A panel too
 *  narrow to honour both keeps the minimum (the panel itself has its own floor). */
export function clampSideWidth(want: number, containerWidth: number): number {
  const max = Math.max(SIDE_WIDTH_MIN, containerWidth - SIDE_READ_MIN)
  return Math.round(Math.min(Math.max(SIDE_WIDTH_MIN, want), max))
}

export function readSideWidth(): number {
  try {
    const n = Number(localStorage.getItem(KEY))
    if (Number.isFinite(n) && n >= SIDE_WIDTH_MIN) return n
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return SIDE_WIDTH_DEFAULT
}

export function storeSideWidth(w: number): void {
  try {
    localStorage.setItem(KEY, String(w))
  } catch {
    /* ignore */
  }
}

/** How far (px, ≤ 0) a clipped label must shift left to show its tail. 0 when it fits. */
export function slideOffset(scrollWidth: number, clientWidth: number): number {
  return Math.min(0, clientWidth - scrollWidth)
}

/**
 * Hover-slide for the column's clipped labels. Installed once per list container (event
 * delegation, so rows may mount and unmount freely). Hovering a row whose label is cut
 * off slides the label's text left, at reading speed, until its tail is in view; leaving
 * the row puts it straight back. Rows whose labels fit are untouched, so the list stays
 * still under an idle pointer. The slide is `text-indent`, animated in CSS (`.fs-slide`),
 * so no wrapper element is needed inside labels that are plain text today.
 *
 * The state is ONE element and no timers, on purpose. An eased slide-back (the class kept
 * on for a moment after leaving) was tried and retired the same day: its
 * timers had to be reconciled with re-entry, with React rewriting the label's className,
 * and with moving straight to the next row — three bugs for one cosmetic, none of which
 * this shape can have.
 *
 * `labelSel` names, within a hovered `rowSel` element, the label candidates; the first one
 * that is actually cut off slides. A row that IS its own label (Changes' directory group
 * headers) passes the same selector for both.
 */
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
  /** The label to slide in `row`: the row itself when it matches, else the FIRST candidate
   *  that is actually cut off — a search hit's dimmed directory (`.ft-rel`) is what shrinks
   *  there, not its name. Null when nothing overflows. */
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
    // still sliding — nothing to do. The class check matters: React rewrites a label's
    // `className` wholesale when its git letter changes (Browse's `.ft-name.git-*`), which
    // wipes `fs-slide` mid-hover; without it the label would count as active and never
    // restart until the pointer left the row.
    if (active && row.contains(active) && active.classList.contains('fs-slide')) return
    reset()
    const label = clippedLabel(row)
    if (!label) return
    active = label
    // ~60 px/s reads comfortably: a long path takes a few seconds, a short overhang under one
    const shift = slideOffset(label.scrollWidth, label.clientWidth)
    label.style.setProperty('--fs-shift', `${shift}px`)
    label.style.setProperty('--fs-dur', `${Math.max(0.4, -shift / 60)}s`)
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
