import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { LayoutV6 } from '@shared/types'
import { migrateLayout, serializeLayout, type MigrateDeps } from './layoutMigrate'
import { projectInfoFor } from './projectInfo'
import { BackgroundFile } from './backgroundFile'

function layoutFile(): string {
  return path.join(app.getPath('userData'), 'layout.json')
}

// PLATFORM§1
const migrateDeps: MigrateDeps = {
  dirExists: (p) => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  projectRootOf: (p) => projectInfoFor(p).root
}

export function loadLayout(): LayoutV6 {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(layoutFile(), 'utf8'))
  } catch {
    raw = undefined
  }
  const layout = migrateLayout(raw, migrateDeps)
  saveLayout(layout)
  return layout
}

const layoutOnDisk = new BackgroundFile(layoutFile)

export function saveLayout(layout: LayoutV6): void {
  layoutOnDisk.write(serializeLayout(layout))
}

export function flushLayout(): void {
  layoutOnDisk.flushSync()
}
