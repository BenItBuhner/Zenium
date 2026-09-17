/**
 * Regenerates every app-icon asset from `src/shared/appIcon.ts`: the per-variant desktop icons
 * under `resources/icons/<id>/` (window / taskbar PNG, Windows ICO, macOS Dock PNG),
 * electron-builder's default `build/icon.{png,ico,icns}`, the Android adaptive-icon layers,
 * colours and launcher aliases, and the Kotlin table of alias names.
 *
 *     npm run icons
 *
 * Re-running it is a no-op when nothing changed; stale variant files are removed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANDROID_MANIFEST,
  ANDROID_RES,
  RUNTIME_ICON_DIR,
  planAppIcons,
  type OutputFile
} from './app-icons/lib.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function main(): void {
  const manifest = readFileSync(join(root, ANDROID_MANIFEST), 'utf8')
  const files = planAppIcons({ manifest })
  let written = 0
  let unchanged = 0
  for (const file of files) {
    if (writeIfChanged(file)) written++
    else unchanged++
  }
  const removed = removeStale(new Set(files.map((f) => f.path)))
  console.log(
    `app icons: ${files.length} files (${written} written, ${unchanged} unchanged, ${removed} stale removed)`
  )
}

function writeIfChanged(file: OutputFile): boolean {
  const target = join(root, file.path)
  const next =
    typeof file.data === 'string' ? Buffer.from(file.data, 'utf8') : Buffer.from(file.data)
  if (existsSync(target) && readFileSync(target).equals(next)) return false
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, next)
  return true
}

/** Variant folders and per-variant Android icons that the palette no longer contains. */
function removeStale(planned: Set<string>): number {
  let removed = 0
  const iconsDir = join(root, RUNTIME_ICON_DIR)
  if (existsSync(iconsDir)) {
    for (const entry of readdirSync(iconsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (planned.has(`${RUNTIME_ICON_DIR}/${entry.name}/icon.png`)) continue
      rmSync(join(iconsDir, entry.name), { recursive: true, force: true })
      removed++
    }
  }
  const mipmaps = join(root, ANDROID_RES, 'mipmap-anydpi-v26')
  if (existsSync(mipmaps)) {
    for (const name of readdirSync(mipmaps)) {
      if (!/^ic_launcher_[a-z]+\.xml$/.test(name)) continue
      if (planned.has(`${ANDROID_RES}/mipmap-anydpi-v26/${name}`)) continue
      rmSync(join(mipmaps, name), { force: true })
      removed++
    }
  }
  return removed
}

main()
