import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'

/** `file.txt` → `file(1).txt`, `file(2).txt`, … until the name is free (Firefox style). */
export function uniquePath(
  dir: string,
  filename: string,
  taken: (path: string) => boolean = existsSync
): string {
  const ext = extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)
  let candidate = join(dir, filename)
  for (let n = 1; taken(candidate); n++) candidate = join(dir, `${stem}(${n})${ext}`)
  return candidate
}
