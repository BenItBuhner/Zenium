import { HIBP_RANGE_URL } from '@core/credentials/checkup'
import { sha1Hex } from '@core/credentials/crypto'

/*
 * The stand-in for the Pwned Passwords range API under the preview host: the leak warning
 * (`autofill=leak-warning`, ID-31) and a checkup are staged against it, never the real service.
 */

/**
 * The sample sign-in's password, the one the stand-in lists as breached; never sent anywhere
 * (the preview's `net.fetch` answers the range request itself).
 */
export const PREVIEW_BREACHED_PASSWORD = 'correct-horse-battery'
export const PREVIEW_BREACH_COUNT = 27_314

/**
 * The answer to a range request (`HIBP_RANGE_URL<prefix>`): for the sample password's prefix,
 * its suffix with its count among padding lines; for any other prefix, padding alone (clean).
 * Padding entries carry a count of 0, the way HIBP's `Add-Padding` ones do. Null for any other
 * URL, which goes out the usual way.
 */
export async function previewRangeAnswer(
  url: string
): Promise<{ ok: boolean; status: number; text: string } | null> {
  if (!url.startsWith(HIBP_RANGE_URL)) return null
  const prefix = url.slice(HIBP_RANGE_URL.length).toUpperCase()
  const hash = (await sha1Hex(PREVIEW_BREACHED_PASSWORD)).toUpperCase()
  const lines: string[] = []
  if (hash.startsWith(prefix)) lines.push(`${hash.slice(5)}:${PREVIEW_BREACH_COUNT}`)
  for (let i = 1; i <= 12; i++) lines.push(`${i.toString(16).toUpperCase().padStart(35, 'A')}:0`)
  return { ok: true, status: 200, text: lines.sort().join('\r\n') }
}
