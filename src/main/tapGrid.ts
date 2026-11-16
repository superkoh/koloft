export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface Grid {
  box: Box
  side: number
  columns: number
  rows: number
}

const SMALLEST_SQUARE_PX = 24
const SQUARES_AIMED_FOR = 120
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const SQUARE = /^([A-Z])(\d{1,3})$/

export function gridOver(box: Box): Grid {
  const side = Math.max(
    SMALLEST_SQUARE_PX,
    Math.ceil(Math.sqrt((box.width * box.height) / SQUARES_AIMED_FOR)),
    Math.ceil(box.width / LETTERS.length)
  )
  return {
    box,
    side,
    columns: Math.ceil(box.width / side),
    rows: Math.ceil(box.height / side)
  }
}

export function squareName(column: number, row: number): string {
  return `${LETTERS[column]}${row + 1}`
}

function middleOf(start: number, side: number, index: number, length: number): number {
  const from = index * side
  const to = Math.min(from + side, length)
  return start + (from + to) / 2
}

export type ReadSquares = { names: string[]; points: Point[] } | { unknown: string[] }

export function readSquares(grid: Grid, text: string): ReadSquares {
  const names = text
    .toUpperCase()
    .split(/[\s,;]+/)
    .filter(Boolean)
  const points: Point[] = []
  const unknown: string[] = []
  for (const name of names) {
    const m = SQUARE.exec(name)
    const column = m ? LETTERS.indexOf(m[1]) : -1
    const row = m ? Number(m[2]) - 1 : -1
    if (column < 0 || column >= grid.columns || row < 0 || row >= grid.rows) {
      unknown.push(name)
      continue
    }
    points.push({
      x: middleOf(grid.box.x, grid.side, column, grid.box.width),
      y: middleOf(grid.box.y, grid.side, row, grid.box.height)
    })
  }
  if (unknown.length || !names.length) return { unknown }
  return { names, points }
}

export function boxAround(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((b) => b.x))
  const top = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.width))
  const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function clipTo(box: Box, view: Box): Box | null {
  const left = Math.max(box.x, view.x)
  const top = Math.max(box.y, view.y)
  const right = Math.min(box.x + box.width, view.x + view.width)
  const bottom = Math.min(box.y + box.height, view.y + view.height)
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

const SHOWN_LONGER_SIDE_PX = 720
const MOST_ENLARGED = 3

function shownScale(box: Box): number {
  return Math.min(
    MOST_ENLARGED,
    Math.max(1, SHOWN_LONGER_SIDE_PX / Math.max(box.width, box.height))
  )
}

export function gridPictureHtml(
  png: Buffer,
  grid: Grid
): { html: string; width: number; height: number } {
  const scale = shownScale(grid.box)
  const width = Math.round(grid.box.width * scale)
  const height = Math.round(grid.box.height * scale)
  const side = grid.side * scale
  const squares: string[] = []
  for (let row = 0; row < grid.rows; row++)
    for (let column = 0; column < grid.columns; column++)
      squares.push(
        `<i style="left:${column * side}px;top:${row * side}px;width:${side}px;height:${side}px"><b>${squareName(column, row)}</b></i>`
      )
  const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#fff;overflow:hidden}
.g{position:relative;width:${width}px;height:${height}px;overflow:hidden}
.g img{position:absolute;left:0;top:0;width:${width}px;height:${height}px}
.g i{position:absolute;box-sizing:border-box;border:1px solid rgba(255,255,255,.9);box-shadow:inset 0 0 0 1px rgba(0,0,0,.45)}
.g b{position:absolute;left:2px;top:2px;font:600 11px/13px -apple-system,Helvetica,Arial,sans-serif;color:#111;background:rgba(255,255,255,.82);padding:0 2px;border-radius:2px}
</style><div class="g"><img src="data:image/png;base64,${png.toString('base64')}">${squares.join('')}</div>`
  return { html, width, height }
}
