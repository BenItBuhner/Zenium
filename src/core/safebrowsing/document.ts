import type { SafeBrowsingThreat } from '../../shared/privacy'
import { safeBrowsingFeed } from './feeds'

/**
 * The file a Safe Browsing feed is kept in: `safebrowsing/<feed>.json` under the profile, written
 * by the service after a refresh and, marked `bundled`, by the snapshot the build ships
 * (`resources/safebrowsing`, `scripts/safebrowsing-snapshot.mts`). A host that
 * reads the files itself (Android's `privacy/SafeBrowsing.kt`) finds everything a hit needs in
 * them. Its own module so the snapshot script loads no more of the core than this.
 */

export const SAFE_BROWSING_DIR = 'safebrowsing'
export const FEED_DOCUMENT_VERSION = 1

/** Persisted table of one feed; also the format of the bundled snapshot. */
export interface FeedDocument {
  version: typeof FEED_DOCUMENT_VERSION
  id: string
  /** What a hit on the feed is reported as. */
  threat: SafeBrowsingThreat
  /** Hosts in the table. */
  entries: number
  /** When the content was fetched (or, for the snapshot, built). */
  updatedAt: number
  etag: string | null
  lastModified: string | null
  /** The content is the snapshot bundled with the build (not yet refreshed). */
  bundled: boolean
  /** Sorted 8-byte prefixes, base64. */
  prefixes: string
}

export function feedFile(id: string): string {
  return `${SAFE_BROWSING_DIR}/${id}.json`
}

/** Parse a persisted or bundled document; null when it is not one (or for another feed). */
export function parseFeedDocument(text: string | null, id: string): FeedDocument | null {
  if (!text) return null
  try {
    const raw = JSON.parse(text) as Partial<FeedDocument>
    if (!raw || raw.version !== FEED_DOCUMENT_VERSION || raw.id !== id) return null
    if (typeof raw.prefixes !== 'string') return null
    const feed = safeBrowsingFeed(id)
    if (!feed) return null
    return {
      version: FEED_DOCUMENT_VERSION,
      id,
      threat: feed.threat,
      entries: typeof raw.entries === 'number' ? raw.entries : 0,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
      etag: typeof raw.etag === 'string' ? raw.etag : null,
      lastModified: typeof raw.lastModified === 'string' ? raw.lastModified : null,
      bundled: raw.bundled === true,
      prefixes: raw.prefixes
    }
  } catch {
    return null
  }
}
