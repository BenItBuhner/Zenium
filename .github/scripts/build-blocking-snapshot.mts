// Refreshes resources/blocking: the snapshot of the default filter lists (src/shared/blocking.ts)
// that ships inside the desktop package and the Android APK so the very first run blocks ads and
// trackers before any list has been downloaded. Each list is reduced to its network filters
// (the same preparation the in-app updater applies) and gzipped; manifest.json carries the
// build time, the versions and counts, and the attribution of every list. Run from the
// repository root:
//
//   npm run blocking:snapshot
//
// The output is committed; the app refreshes the lists from their canonical URLs on its own
// schedule, so the snapshot only has to be recent, not current.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { DEFAULT_FILTER_LISTS } from '../../src/shared/blocking.ts'
import { parseListHeader, prepareListText } from '../../src/core/blocking/lists.ts'

const OUT_DIR = resolve('resources/blocking')
const ATTEMPTS = 3

interface ManifestList {
  id: string
  file: string
  version: string | null
  filterCount: number
  /** Canonical download URL the snapshot was taken from. */
  url: string
  name: string
  homepage: string
  licence: string
}

async function download(url: string): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'text/plain, */*;q=0.5',
          'User-Agent': 'Zenium filter snapshot (+https://github.com/BenItBuhner/Zenium)'
        },
        signal: AbortSignal.timeout(90_000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (/^\s*</.test(text)) throw new Error('the response is HTML, not a filter list')
      return text
    } catch (error) {
      lastError = error
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 2_000))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  for (const stale of readdirSync(OUT_DIR)) rmSync(join(OUT_DIR, stale), { force: true })
  const builtAt = Date.now()
  const lists: ManifestList[] = []
  for (const def of DEFAULT_FILTER_LISTS) {
    const raw = await download(def.url)
    const header = parseListHeader(raw)
    const prepared = prepareListText(raw)
    if (prepared.count === 0) throw new Error(`${def.id}: no network filters in ${def.url}`)
    const file = `${def.id}.txt.gz`
    const gz = gzipSync(prepared.text, { level: 9 })
    writeFileSync(join(OUT_DIR, file), gz)
    lists.push({
      id: def.id,
      file,
      version: header.version,
      filterCount: prepared.count,
      url: def.url,
      name: def.name,
      homepage: def.homepage,
      licence: def.licence
    })
    console.log(
      `${def.id.padEnd(14)} ${String(prepared.count).padStart(7)} filters  ${String(gz.length).padStart(8)} bytes gzipped  ${header.version ?? '-'}`
    )
  }
  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify({ builtAt, lists }, null, 2)}\n`)
  console.log(
    `wrote ${lists.length} lists to ${OUT_DIR} (builtAt ${new Date(builtAt).toISOString()})`
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
