// Refreshes resources/safebrowsing: the snapshot of the bundled Safe Browsing feeds
// (src/core/safebrowsing/feeds.ts, `bundled: true`) that ships inside the desktop package and
// the Android APK so the very first run refuses known malware and phishing sites before any feed
// has been downloaded. Each feed is hashed into the prefix table the app keeps on disk
// (`FeedDocument` in src/core/safebrowsing/service.ts) – the same file the app writes after a
// refresh, marked `bundled` – and manifest.json carries the build time, the counts and the
// attribution of every feed. Run from the repository root:
//
//   npm run safebrowsing:snapshot
//
// The output is committed; the app refreshes the feeds from their canonical URLs on its own
// schedule (their validators are in the documents, so the first refresh is conditional), so the
// snapshot only has to be recent, not current.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FEED_DOCUMENT_VERSION, type FeedDocument } from '../../src/core/safebrowsing/document.ts'
import { SAFE_BROWSING_FEEDS, parseFeed } from '../../src/core/safebrowsing/feeds.ts'
import { PrefixTable } from '../../src/core/safebrowsing/prefixes.ts'

const OUT_DIR = resolve('resources/safebrowsing')
const ATTEMPTS = 3

interface ManifestFeed {
  id: string
  file: string
  entries: number
  /** Canonical download URL the snapshot was taken from. */
  url: string
  name: string
  homepage: string
  licence: string
  threat: string
}

interface Downloaded {
  text: string
  etag: string | null
  lastModified: string | null
}

async function download(url: string): Promise<Downloaded> {
  let lastError: unknown
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'text/plain, */*;q=0.5',
          'User-Agent': 'Zenium Safe Browsing snapshot (+https://github.com/BenItBuhner/Zenium)'
        },
        signal: AbortSignal.timeout(90_000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (/^\s*</.test(text)) throw new Error('the response is HTML, not a host list')
      return {
        text,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified')
      }
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
  const feeds: ManifestFeed[] = []
  for (const feed of SAFE_BROWSING_FEEDS) {
    if (!feed.bundled) continue
    const got = await download(feed.url)
    const hosts = parseFeed(got.text, feed.format)
    if (hosts.length === 0) throw new Error(`${feed.id}: no hosts in ${feed.url}`)
    const table = PrefixTable.fromHosts(hosts)
    const doc: FeedDocument = {
      version: FEED_DOCUMENT_VERSION,
      id: feed.id,
      threat: feed.threat,
      entries: table.size,
      updatedAt: builtAt,
      etag: got.etag,
      lastModified: got.lastModified,
      bundled: true,
      prefixes: table.toBase64()
    }
    const file = `${feed.id}.json`
    const json = JSON.stringify(doc)
    writeFileSync(join(OUT_DIR, file), json)
    feeds.push({
      id: feed.id,
      file,
      entries: table.size,
      url: feed.url,
      name: feed.name,
      homepage: feed.homepage,
      licence: feed.licence,
      threat: feed.threat
    })
    console.log(
      `${feed.id.padEnd(18)} ${String(table.size).padStart(7)} hosts  ${String(json.length).padStart(8)} bytes  ${feed.threat}`
    )
  }
  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify({ builtAt, feeds }, null, 2)}\n`)
  console.log(
    `wrote ${feeds.length} feeds to ${OUT_DIR} (builtAt ${new Date(builtAt).toISOString()})`
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
