/**
 * Opt-in end-to-end check against the real stores. Never runs in CI: set ZENIUM_LIVE_STORE=1 to
 * enable it, ZENIUM_LIVE_STORE_IDS to a comma-separated list of extension ids (a store-page URL
 * works too) to override the default sample, and ZENIUM_LIVE_STORE_OUT to a file path to receive
 * one JSON line per package for offline analysis.
 *
 *   ZENIUM_LIVE_STORE=1 npx vitest run src/core/extensions/__tests__/live-store.test.ts
 */
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line no-restricted-imports
import { appendFileSync } from 'node:fs'
import { utf8DecodeLenient } from '../bytes'
import { CrxError } from '../crx'
import { InstallError, checkForUpdate, installFromCrx, installFromZip } from '../install'
import {
  crxDownloadUrl,
  isExtensionId,
  parseOmahaResponse,
  parseStorePageUrl,
  updateCheckUrl,
  type StoreFetch,
  type StoreId
} from '../store'
import { ZipError } from '../zip'

const LIVE = process.env.ZENIUM_LIVE_STORE === '1'
const OUT = process.env.ZENIUM_LIVE_STORE_OUT
const DEFAULT_IDS = [
  'ddkjiahejlhfcafbddmgiahcphecmpfh', // uBlock Origin Lite (Chrome Web Store)
  'dbepggeogbaibhgnhhndojpepiihcmeb', // Vimium (Chrome Web Store)
  'odfafepnkmbhccpbejgmiehpchacaeak' // uBlock Origin (Edge Add-ons only)
]
const options = { chromiumVersion: '152.0.0.0' }

const hostFetch: StoreFetch = async (url) => {
  const response = await globalThis.fetch(url, { redirect: 'follow' })
  return {
    status: response.status,
    url: response.url,
    bytes: new Uint8Array(await response.arrayBuffer())
  }
}

function record(line: Record<string, unknown>): void {
  const text = JSON.stringify(line)
  console.log(text)
  if (OUT) appendFileSync(OUT, `${text}\n`)
}

function requestedIds(): string[] {
  const raw = process.env.ZENIUM_LIVE_STORE_IDS
  if (!raw) return DEFAULT_IDS
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => parseStorePageUrl(item)?.id ?? item)
}

function errorCode(error: unknown): string {
  if (error instanceof CrxError || error instanceof ZipError || error instanceof InstallError) {
    return `${error.name}:${error.code}`
  }
  return error instanceof Error ? error.message : String(error)
}

describe.runIf(LIVE)('live store install', () => {
  it(
    'downloads, verifies and unpacks every requested package (Chrome Web Store, then Edge Add-ons)',
    async () => {
      const failures: string[] = []
      for (const id of requestedIds()) {
        if (!isExtensionId(id)) {
          record({ id, ok: false, error: 'not a valid extension id' })
          failures.push(`${id}: not a valid extension id`)
          continue
        }
        const stores: StoreId[] = ['chrome-web-store', 'edge-add-ons']
        let response: Awaited<ReturnType<StoreFetch>> | null = null
        let store: StoreId | null = null
        const statuses: Record<string, number> = {}
        for (const candidate of stores) {
          const attempt = await hostFetch(crxDownloadUrl(candidate, id, options))
          statuses[candidate] = attempt.status
          if (attempt.status === 200 && attempt.bytes.length > 0) {
            response = attempt
            store = candidate
            break
          }
        }
        if (!response) {
          record({ id, ok: false, statuses })
          failures.push(`${id}: ${JSON.stringify(statuses)}`)
          continue
        }
        const started = performance.now()
        try {
          const pkg = await installFromCrx(response.bytes, { expectedId: id })
          // Force every entry through inflate + CRC so the timing covers the whole package.
          for (const file of pkg.files) await file.bytes()
          const elapsedMs = Math.round(performance.now() - started)
          record({
            id,
            ok: true,
            store,
            name: pkg.manifest.name,
            version: pkg.version,
            manifestVersion: pkg.manifest.manifest_version,
            crxBytes: response.bytes.length,
            unpackedBytes: pkg.totalSize,
            files: pkg.files.length,
            publisher: pkg.publisher,
            warnings: pkg.warnings.map((w) => (w.path ? `${w.path}: ${w.message}` : w.message)),
            elapsedMs
          })
        } catch (error) {
          record({ id, ok: false, store, crxBytes: response.bytes.length, error: errorCode(error) })
          failures.push(`${id}: ${errorCode(error)}`)
        }
      }
      expect(failures).toEqual([])
    },
    20 * 60_000
  )

  it(
    'runs one update check per store and prints the raw Omaha XML',
    async () => {
      const checks: Array<{ store: StoreId; id: string }> = [
        { store: 'chrome-web-store', id: 'ddkjiahejlhfcafbddmgiahcphecmpfh' },
        { store: 'edge-add-ons', id: 'odfafepnkmbhccpbejgmiehpchacaeak' }
      ]
      for (const { store, id } of checks) {
        const url = updateCheckUrl(store, [{ id, version: '0.1' }], options)
        const response = await hostFetch(url)
        const xml = utf8DecodeLenient(response.bytes)
        record({ updateCheck: store, url, status: response.status, xml })
        const [app] = parseOmahaResponse(xml)
        expect(app.appId).toBe(id)
        expect(app.status).toBe('ok')
        expect(app.update?.version).toBeTruthy()
        const result = await checkForUpdate(hostFetch, { id, version: '0.1', store }, options)
        expect(result.status).toBe('update-available')
      }
    },
    2 * 60_000
  )

  it(
    'sideloads the uBlock Origin GitHub release zip (unsigned, wrapped in a top-level folder)',
    async () => {
      const release = await hostFetch('https://api.github.com/repos/gorhill/uBlock/releases/latest')
      if (release.status !== 200) {
        record({ sideload: 'uBlock Origin', skipped: `GitHub API HTTP ${release.status}` })
        return
      }
      const parsed = JSON.parse(utf8DecodeLenient(release.bytes)) as {
        tag_name: string
        assets: Array<{ name: string; browser_download_url: string }>
      }
      const asset = parsed.assets.find((a) => /^uBlock0_.*\.chromium\.zip$/.test(a.name))
      expect(asset).toBeDefined()
      const zip = await hostFetch(asset!.browser_download_url)
      expect(zip.status).toBe(200)
      const started = performance.now()
      const pkg = await installFromZip(zip.bytes, { idSeed: '/extensions/ublock-origin' })
      for (const file of pkg.files) await file.bytes()
      record({
        sideload: 'uBlock Origin',
        tag: parsed.tag_name,
        asset: asset!.name,
        id: pkg.id,
        name: pkg.manifest.name,
        version: pkg.version,
        manifestVersion: pkg.manifest.manifest_version,
        rootPrefix: pkg.rootPrefix,
        zipBytes: zip.bytes.length,
        unpackedBytes: pkg.totalSize,
        files: pkg.files.length,
        warnings: pkg.warnings.map((w) => (w.path ? `${w.path}: ${w.message}` : w.message)),
        elapsedMs: Math.round(performance.now() - started)
      })
      expect(pkg.manifest.name).toBe('uBlock Origin')
      expect(pkg.signed).toBe(false)
    },
    5 * 60_000
  )
})
