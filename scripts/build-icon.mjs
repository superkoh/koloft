#!/usr/bin/env node
// Build the macOS app icon from its SVG source.
//
//   node scripts/build-icon.mjs                      # build/icon.svg -> build/icon.icns
//   node scripts/build-icon.mjs --preview out.png    # also render a review sheet (sizes on light/dark)
//   node scripts/build-icon.mjs --svg a.svg --png out.png [--size 1024]   # just rasterize
//
// build/icon.svg is the source of truth; the .icns is a derived artifact checked in so a
// packaging run needs no browser. Rendering goes through the Chromium that Playwright
// already ships for the e2e suite (headless — never a visible window), then `sips` scales
// the 1024px master into the ten sizes an .iconset wants and `iconutil` packs them.
import { chromium } from '@playwright/test'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const svgPath = path.resolve(opt('--svg', path.join(root, 'build', 'icon.svg')))
const pngOnly = opt('--png', null)
const preview = opt('--preview', null)
const size = Number(opt('--size', '1024'))

const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1
  })

  async function rasterize(svgFile, out, px) {
    const svg = fs
      .readFileSync(svgFile, 'utf8')
      .replace('<svg ', `<svg style="width:${px}px;height:${px}px;display:block" `)
    await page.setViewportSize({ width: px, height: px })
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg}</body></html>`
    )
    await page.screenshot({ path: out, omitBackground: true })
  }

  if (pngOnly) {
    await rasterize(svgPath, path.resolve(pngOnly), size)
    console.log(`wrote ${pngOnly}`)
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-icon-'))
    const master = path.join(work, 'master.png')
    await rasterize(svgPath, master, 1024)
    const iconset = path.join(work, 'icon.iconset')
    fs.mkdirSync(iconset)
    // Apple's naming: icon_<pt>x<pt>[@2x].png, where @2x holds double the pixels
    for (const pt of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const px = pt * scale
        const name = `icon_${pt}x${pt}${scale === 2 ? '@2x' : ''}.png`
        execFileSync(
          'sips',
          ['-z', String(px), String(px), master, '--out', path.join(iconset, name)],
          { stdio: 'ignore' }
        )
      }
    }
    const icns = path.join(root, 'build', 'icon.icns')
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns])
    console.log(
      `wrote ${path.relative(root, icns)} (${(fs.statSync(icns).size / 1024).toFixed(0)} KB)`
    )
    if (preview) {
      // review sheet: the icon at Dock/Finder/menu sizes on both appearances
      const dataUrl = 'data:image/png;base64,' + fs.readFileSync(master).toString('base64')
      const cell = (px) =>
        `<figure><img src="${dataUrl}" width="${px}" height="${px}"><figcaption>${px}</figcaption></figure>`
      const row = (bg, fg) =>
        `<section style="background:${bg};color:${fg}">${[512, 256, 128, 64, 32, 16].map(cell).join('')}</section>`
      await page.setViewportSize({ width: 1400, height: 1240 })
      await page.setContent(`<html><body style="margin:0;font:14px -apple-system,Helvetica">
        <style>section{display:flex;align-items:flex-end;gap:36px;padding:48px 56px}figure{margin:0;text-align:center}img{display:block;margin:0 auto 8px;image-rendering:auto}</style>
        ${row('#f2f2f7', '#333')}${row('#1c1c1e', '#ddd')}
        <section style="background:linear-gradient(135deg,#7aa2ff,#e28cc8);color:#fff">${[128, 64, 32].map(cell).join('')}</section>
      </body></html>`)
      await page.screenshot({ path: path.resolve(preview), fullPage: true })
      console.log(`wrote ${preview}`)
    }
    fs.rmSync(work, { recursive: true, force: true })
  }
} finally {
  await browser.close()
}
