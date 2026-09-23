import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { LayoutV4 } from '@shared/types'
import { migrateLayout, serializeLayout, type MigrateDeps } from './layoutMigrate'
import { projectInfoFor } from './projectInfo'

/**
 * layout.json (next to settings.json). Since v2 it holds only Koloft's organizational
 * data — workspaces[] + per-session panel state; v3
 * replaced the aux column's mode with the Workbench's `{open, tabs}`; v4 keeps
 * that shape and lands every panel collapsed once (see `layoutMigrate`). The v1
 * open-tab snapshot is no longer written: sessions re-aggregate from Claude's own
 * storage and a restart lands cold (A10/A11).
 */
function layoutFile(): string {
  return path.join(app.getPath('userData'), 'layout.json')
}

// projectInfoFor is pure fs — a Finder-launched packaged app inherits launchd's
// minimal PATH, where shelling out to git would silently fail (see projectInfo.ts)
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

/** Load the v4 layout, migrating a v3/v2/v1 (or corrupt) file one-shot on first read
 *  (§9). The migrated document is written back immediately, so migration runs
 *  exactly once per upgrade. */
export function loadLayout(): LayoutV4 {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(layoutFile(), 'utf8'))
  } catch {
    raw = undefined
  }
  const layout = migrateLayout(raw, migrateDeps)
  // the read always rebuilds the document (every session entry goes through the sanitizer),
  // so the write is unconditional rather than reference-compared. It stays one-shot
  // where it matters: migrateLayout is idempotent, so the rewrite is byte-identical
  // from the second cold start on (NFR-06).
  saveLayout(layout)
  return layout
}

export function saveLayout(layout: LayoutV4): void {
  try {
    fs.writeFileSync(layoutFile(), serializeLayout(layout))
  } catch {
    /* best effort — a failed layout write must never crash the app */
  }
}
