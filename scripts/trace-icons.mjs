#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { PNG } from 'pngjs'
import potrace from 'potrace'
import prettier from 'prettier'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const iconDir = path.join(root, 'src', 'renderer', 'src', 'icons')
const sheets = JSON.parse(fs.readFileSync(path.join(iconDir, 'sheets.json'), 'utf8'))
const COLUMNS = 6
const ROWS = 4
const VIEWBOX = 24
const CROP_SIDE_IN_STROKES = 15
const LIT = 128

function readSheet(file) {
  const { width, height, data } = PNG.sync.read(fs.readFileSync(file))
  const lit = new Uint8Array(width * height)
  for (let i = 0; i < lit.length; i++)
    lit[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3 > LIT ? 1 : 0
  return { width, height, lit }
}

function bands(counts, n) {
  const runs = []
  let start = -1
  counts.forEach((v, i) => {
    if (v > 0 && start < 0) start = i
    if (v === 0 && start >= 0) {
      runs.push([start, i - 1])
      start = -1
    }
  })
  if (start >= 0) runs.push([start, counts.length - 1])
  while (runs.length > n) {
    let narrowest = 0
    for (let i = 1; i < runs.length - 1; i++)
      if (runs[i + 1][0] - runs[i][1] < runs[narrowest + 1][0] - runs[narrowest][1]) narrowest = i
    runs.splice(narrowest, 2, [runs[narrowest][0], runs[narrowest + 1][1]])
  }
  return runs
}

function strokeWidth({ width, height, lit }) {
  const across = new Uint16Array(width * height).fill(65535)
  for (let y = 0; y < height; y++) {
    let x = 0
    while (x < width) {
      if (!lit[y * width + x]) {
        x++
        continue
      }
      let end = x
      while (end < width && lit[y * width + end]) end++
      for (let i = x; i < end; i++) across[y * width + i] = end - x
      x = end
    }
  }
  for (let x = 0; x < width; x++) {
    let y = 0
    while (y < height) {
      if (!lit[y * width + x]) {
        y++
        continue
      }
      let end = y
      while (end < height && lit[end * width + x]) end++
      for (let i = y; i < end; i++) across[i * width + x] = Math.min(across[i * width + x], end - y)
      y = end
    }
  }
  const runs = across.filter((v) => v !== 65535).sort((a, b) => a - b)
  return runs[runs.length >> 1]
}

function glyphBoxes(sheet) {
  const { width, height, lit } = sheet
  const columnCounts = new Array(width).fill(0)
  const rowCounts = new Array(height).fill(0)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (lit[y * width + x]) {
        columnCounts[x]++
        rowCounts[y]++
      }
  const xs = bands(columnCounts, COLUMNS)
  const ys = bands(rowCounts, ROWS)
  if (xs.length !== COLUMNS || ys.length !== ROWS)
    throw new Error(`found a ${xs.length}×${ys.length} grid, want ${COLUMNS}×${ROWS}`)
  const boxes = []
  for (const [y0, y1] of ys)
    for (const [x0, x1] of xs) {
      const box = { x0: width, y0: height, x1: -1, y1: -1 }
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
          if (lit[y * width + x]) {
            box.x0 = Math.min(box.x0, x)
            box.x1 = Math.max(box.x1, x)
            box.y0 = Math.min(box.y0, y)
            box.y1 = Math.max(box.y1, y)
          }
      if (box.x1 < 0) throw new Error(`empty cell at column ${x0}, row ${y0}`)
      boxes.push(box)
    }
  return boxes
}

function crop({ width, height, lit }, box, side) {
  const out = new PNG({ width: side, height: side })
  const left = Math.round((box.x0 + box.x1 - side) / 2)
  const top = Math.round((box.y0 + box.y1 - side) / 2)
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const sx = left + x
      const sy = top + y
      const on = sx >= 0 && sy >= 0 && sx < width && sy < height && lit[sy * width + sx]
      const o = (y * side + x) * 4
      out.data[o] = out.data[o + 1] = out.data[o + 2] = on ? 0 : 255
      out.data[o + 3] = 255
    }
  return PNG.sync.write(out)
}

function trace(png, side) {
  return new Promise((resolve, reject) =>
    potrace.trace(png, { threshold: 128, turdSize: 8, optTolerance: 0.4 }, (err, svg) => {
      if (err) return reject(err)
      const d = svg.match(/ d="([^"]+)"/)[1]
      const scale = VIEWBOX / side
      resolve(
        d
          .replace(/-?\d+(\.\d+)?/g, (n) => String(Math.round(Number(n) * scale * 100) / 100))
          .replace(/ ?([MCLZ]) ?/g, '$1')
          .replace(/, /g, ',')
          .trim()
      )
    })
  )
}

const paths = {}
for (const [file, names] of Object.entries(sheets)) {
  const sheet = readSheet(path.join(iconDir, file))
  const stroke = strokeWidth(sheet)
  const side = stroke * CROP_SIDE_IN_STROKES
  const boxes = glyphBoxes(sheet)
  for (const [i, name] of names.entries()) {
    if (!name) continue
    const box = boxes[i]
    if (Math.max(box.x1 - box.x0, box.y1 - box.y0) >= side)
      throw new Error(`${name} in ${file} is wider than its ${side}px crop`)
    paths[name] = await trace(crop(sheet, box, side), side)
  }
  console.log(`${file}: stroke ${stroke}px, crop ${side}px`)
}

const out = path.join(iconDir, 'paths.ts')
const source = `export const ICON_PATHS = {\n${Object.keys(paths)
  .sort()
  .map((name) => `  ${name}: '${paths[name]}'`)
  .join(',\n')}\n}\n`
const options = await prettier.resolveConfig(out)
fs.writeFileSync(out, await prettier.format(source, { ...options, filepath: out }))
console.log(`wrote ${path.relative(root, out)}: ${Object.keys(paths).length} icons`)
