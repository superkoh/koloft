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

const CONTAINER_TYPES = new Set(['Application', 'Window', 'Group', 'ScrollArea', 'Other'])

function kebab(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
}

function text(v: string | null | undefined): string {
  return (v ?? '').replace(/\s+/g, ' ').trim()
}

export function axElements(roots: AxNode[]): ScreenElement[] {
  const out: ScreenElement[] = []
  const walk = (node: AxNode): void => {
    const type = node.type ?? ''
    const label = text(node.AXLabel) || text(node.title)
    const value = text(node.AXValue)
    const f = node.frame
    const named = !!label || !!value
    if (f && f.width > 0 && f.height > 0 && (!CONTAINER_TYPES.has(type) || named) && type)
      out.push({
        role: kebab(type),
        label,
        value,
        x: Math.round(f.x + f.width / 2),
        y: Math.round(f.y + f.height / 2)
      })
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
