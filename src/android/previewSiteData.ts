import { DEFAULT_CONTAINER_ID } from '@shared/types'
import type { NativeCookie, NativeOriginReading } from './siteData'

/**
 * The preview host's stand-in for what Kotlin's `SiteData` reads out of the container's WebView
 * profile (`site.listOrigins`, `site.cookies`): the desktop has no jar of the WebView's to look
 * into, so a `sitedata=` preview state (previewStates.ts) picks a sample for the site-data viewer
 * and the site-information sheet to lay out, and the stand-in answers from it. `none` is the
 * empty viewer; `some` a dozen origins with the sizes and cookie counts a phone's profile might
 * hold, two of them unsized (the storage line's "Size unavailable"); `many` a thousand and
 * some, so the viewer stops at its cap and says so. The active tab's site (example.com) keeps
 * a few cookies under `some` and `many`, so the sheet's cookies level has rows under the
 * per-site policy row.
 */

/** Raised on `window` by a `sitedata=` preview state: the stand-in takes the sample named. */
export const PREVIEW_SITE_DATA_EVENT = 'zen-preview-site-data'

export const PREVIEW_SITE_DATA_ORIGINS = ['none', 'some', 'many'] as const
export type PreviewSiteDataOrigins = (typeof PREVIEW_SITE_DATA_ORIGINS)[number]

export function isPreviewSiteDataOrigins(value: string | null): value is PreviewSiteDataOrigins {
  return (PREVIEW_SITE_DATA_ORIGINS as readonly string[]).includes(value ?? '')
}

/** The origins of `some`, the most data first as the viewer sorts them. */
const SOME_ORIGINS: NativeOriginReading[] = [
  { origin: 'https://video.example', cookies: 14, usageBytes: 268_435_456 },
  { origin: 'https://mail.example', cookies: 22, usageBytes: 41_943_040 },
  { origin: 'https://docs.example', cookies: 9, usageBytes: 12_582_912 },
  { origin: 'https://example.com', cookies: 5, usageBytes: 1_572_864 },
  { origin: 'https://shop.example', cookies: 31, usageBytes: 917_504 },
  { origin: 'https://news.example', cookies: 12, usageBytes: 344_064 },
  { origin: 'https://maps.example', cookies: 3, usageBytes: 196_608 },
  { origin: 'https://chat.example', cookies: 7, usageBytes: 65_536 },
  { origin: 'https://tracker.example', cookies: 18, usageBytes: null },
  { origin: 'https://ads.example', cookies: 6, usageBytes: null },
  { origin: 'https://forum.example:8443', cookies: 2, usageBytes: 12_288 },
  { origin: 'http://legacy.example', cookies: 1, usageBytes: 4_096 }
]

/** How many origins `many` answers: past the viewer's cap of 1 000. */
export const PREVIEW_MANY_ORIGINS = 1_024

/**
 * What the stand-in `site.listOrigins` answers for one container: the sample's origins, plus
 * an entry for any probed origin of the sample's page (the core probes the origins it knows,
 * which the sample already names; a probe for another origin answers nothing stored).
 */
export function previewOrigins(
  variant: PreviewSiteDataOrigins,
  containerId: string
): NativeOriginReading[] {
  // The viewer sums a site's containers: the sample's data sits in the default container only,
  // so the totals are the sample's own.
  if (containerId !== DEFAULT_CONTAINER_ID) return []
  switch (variant) {
    case 'none':
      return []
    case 'some':
      return SOME_ORIGINS
    case 'many': {
      const rows: NativeOriginReading[] = [...SOME_ORIGINS]
      for (let i = rows.length; i < PREVIEW_MANY_ORIGINS; i++) {
        // Sizes falling from a few megabytes to a few bytes, with a cookie or two each, so the
        // cap keeps the biggest and the count line names the rest.
        const usage = Math.max(1, Math.round(4_000_000 / (i + 1)))
        rows.push({
          origin: `https://site-${String(i).padStart(4, '0')}.example`,
          cookies: 1 + (i % 3),
          usageBytes: usage
        })
      }
      return rows
    }
  }
}

/** The active tab's site's cookies (`site.cookies` for `https://example.com/…`) under a sample with data. */
export function previewCookies(variant: PreviewSiteDataOrigins, url: string): NativeCookie[] {
  if (variant === 'none') return []
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return []
  }
  if (host !== 'example.com' && !host.endsWith('.example.com')) return []
  return [
    { name: 'session', domain: 'example.com', secure: true, size: 71 },
    { name: '_ga', domain: '.example.com', secure: false, size: 38 },
    { name: 'consent', domain: '.example.com', secure: true, size: 24 },
    { name: 'theme', domain: 'example.com', secure: false, size: 11 },
    { name: 'csrf', domain: 'example.com', secure: true, size: 64 }
  ]
}
