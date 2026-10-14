export interface ScreenElement {
  role: string
  label: string
  value: string
  x: number
  y: number
}

export interface AxNode {
  type?: string | null
  AXLabel?: string | null
  AXValue?: string | null
  title?: string | null
  frame?: { x: number; y: number; width: number; height: number }
  children?: AxNode[]
}

function kebab(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
}

function text(v: string | null | undefined): string {
  return (v ?? '').replace(/\s+/g, ' ').trim()
}

export function axElements(roots: AxNode[]): ScreenElement[] {
  const screen = axScreenSize(roots)
  const onScreen = (x: number, y: number): boolean =>
    !screen || (x >= 0 && y >= 0 && x <= screen.width && y <= screen.height)
  const out: ScreenElement[] = []
  const walk = (node: AxNode): void => {
    const type = node.type ?? ''
    const label = text(node.AXLabel) || text(node.title)
    const value = text(node.AXValue)
    const f = node.frame
    if (f && f.width > 0 && f.height > 0 && type && (label || value)) {
      const x = Math.round(f.x + f.width / 2)
      const y = Math.round(f.y + f.height / 2)
      if (onScreen(x, y)) out.push({ role: kebab(type), label, value, x, y })
    }
    for (const child of node.children ?? []) walk(child)
  }
  for (const root of roots) walk(root)
  return out.filter((e) => e.role !== 'application')
}

export function axScreenSize(roots: AxNode[]): { width: number; height: number } | null {
  const f = roots[0]?.frame
  return f && f.width > 0 && f.height > 0 ? { width: f.width, height: f.height } : null
}

export function elementLines(elements: ScreenElement[]): string {
  return elements
    .map((e, i) => {
      const label = e.label ? ` "${e.label}"` : ''
      const value = e.value ? ` value="${e.value}"` : ''
      return `@e${i + 1} [${e.role}]${label}${value} at ${e.x} ${e.y}`
    })
    .join('\n')
}

export function elementAt(elements: ScreenElement[], ref: string): ScreenElement | undefined {
  const n = /^@e(\d+)$/.exec(ref)?.[1]
  return n ? elements[Number(n) - 1] : undefined
}
