/**
 * The file-backed handoffs from the Kotlin host (`BootHandoff.kt`): what is too big to travel
 * JSON-quoted through the bridge – a string of megabytes is escaped by Kotlin, copied through
 * JNI, parsed by the JS engine and copied again, all of it on the chrome's main thread – comes
 * as a file on the app origin instead, fetched off the main thread like any resource.
 *
 *  - Boot documents. The boot payload inlines the core's documents while they are small; the
 *    rest (a Safe Browsing feed's prefix table) it lists by name, size and version tag, and
 *    {@link fetchDeferredDocuments} brings them in from `/zen-docs/<name>` while the platform and
 *    the core are built, so that the core's synchronous reads at start find them as before.
 *  - Fetched bodies. `net.fetch` answers a body over the host's inline limit as `{token, bytes}`;
 *    {@link readSpilledBody} fetches `/zen-net/<token>` and releases the file.
 *  - The bundled Safe Browsing snapshot, an asset of the APK, is fetched from the asset path.
 *
 * Every path falls back to the bridge call the payload used before the handoff, so a chrome
 * served from the dev server (another origin, whose fetches of the app origin fail) keeps
 * working, slower.
 */
import { APP_ORIGIN } from './extensionStoreIo'

/** The document handler's path prefix (`DOCS_PATH` in `BootHandoff.kt`). */
export const DOCS_PATH = '/zen-docs/'
/** The spilled bodies' path prefix (`NET_PATH` in `BootHandoff.kt`). */
export const NET_PATH = '/zen-net/'
/** The APK's bundled Safe Browsing snapshot (`Privacy.SNAPSHOT_DIR`), through the asset loader. */
export const BUNDLED_FEEDS_PATH = '/assets/safebrowsing/'

/** One document the boot payload named instead of inlining (`Storage.bootDocuments`). */
export interface DeferredDocument {
  name: string
  bytes: number
  /** The version tag of the file (`Storage.etag`), echoed as the `ETag` of the fetch. */
  etag: string
}

/** A spilled `net.fetch` body as Kotlin reports it. */
export interface SpilledBody {
  token: string
  bytes: number
}

/** The part of `fetch` the handoff uses (`window.fetch` in the chrome; a stub in the tests). */
export type HandoffFetch = (
  url: string,
  init: { cache: 'no-store' }
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

export interface DeferredDocumentReader {
  fetch: HandoffFetch
  /** The pre-handoff path (`storage.read` through the bridge), for a document the fetch cannot bring. */
  readSync(name: string): string | null
  origin?: string
}

/** `/zen-docs/blocking/index.json`: names are one or two safe path segments (`Storage.fileFor`). */
export function documentUrl(name: string, origin = APP_ORIGIN): string {
  return `${origin}${DOCS_PATH}${name.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Bring in the documents the boot payload deferred, in parallel, as `name → text`. A document
 * the handler cannot serve (the file went away between the payload and the fetch, a chrome on
 * another origin) is read the old way; one that is gone from both is simply absent, as a
 * missing file always was. The tag the handler echoes is compared with the manifest's: a
 * difference means the core rewrote the document in between, and the fetched (newer) text is
 * the right one to hand over.
 */
export async function fetchDeferredDocuments(
  deferred: readonly DeferredDocument[] | undefined,
  reader: DeferredDocumentReader
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!deferred || deferred.length === 0) return out
  await Promise.all(
    deferred.map(async (doc) => {
      const text = await fetchDocument(doc, reader)
      if (text !== null) out[doc.name] = text
    })
  )
  return out
}

async function fetchDocument(
  doc: DeferredDocument,
  reader: DeferredDocumentReader
): Promise<string | null> {
  try {
    const response = await reader.fetch(documentUrl(doc.name, reader.origin), { cache: 'no-store' })
    if (response.ok) {
      const tag = response.headers.get('ETag')?.replace(/^"|"$/g, '') ?? null
      if (tag !== null && tag !== doc.etag)
        console.info(`[zen] ${doc.name} was rewritten while booting (${doc.etag} → ${tag})`)
      return await response.text()
    }
    if (response.status !== 404)
      console.warn(`[zen] the document handler answered ${response.status} for ${doc.name}`)
  } catch (error) {
    console.warn(`[zen] could not fetch ${doc.name} from the document handler:`, error)
  }
  return reader.readSync(doc.name)
}

/**
 * The text of a `net.fetch` body Kotlin spilled to a file: fetched once by token, then released
 * (whatever happened; a file the chrome never reads is swept at the next start anyway).
 */
export async function readSpilledBody(
  body: SpilledBody,
  fetch: HandoffFetch,
  release: (token: string) => void,
  origin = APP_ORIGIN
): Promise<string> {
  if (!/^[0-9a-f]{32}$/.test(body.token)) throw new Error('the spilled body has no valid token')
  try {
    const response = await fetch(`${origin}${NET_PATH}${body.token}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`the spilled body could not be read (${response.status})`)
    return await response.text()
  } finally {
    release(body.token)
  }
}

/**
 * The bundled snapshot of one feed (`assets/safebrowsing/<id>.json`) through the asset loader,
 * or null when the fetch cannot bring it (no such feed bundled, another origin); the caller
 * falls back to the bridge then.
 */
export async function fetchBundledFeed(
  id: string,
  fetch: HandoffFetch,
  origin = APP_ORIGIN
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null
  try {
    const response = await fetch(`${origin}${BUNDLED_FEEDS_PATH}${id}.json`, { cache: 'no-store' })
    if (!response.ok) return null
    const text = await response.text()
    return text || null
  } catch {
    return null
  }
}
