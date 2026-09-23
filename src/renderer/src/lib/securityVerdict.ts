import { Lock, LockOpen, ShieldAlert, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { IndicatorState } from '@shared/siteInfo'

/** The status ink a verdict draws in (v2 §1, §9.19): ink only, never a fill. */
export type SecurityTone = 'ok' | 'warn' | 'danger' | 'neutral'

/**
 * What the connection's glyph says, on the phone pill's glyph slot and on the site-information
 * sheet's title block and Connection row alike (ERR-09; v2 §9.19, §9.29): one glyph, one tone,
 * one name for a state, so the chip promises what the sheet explains.
 */
export interface SecurityVerdict {
  glyph: LucideIcon
  tone: SecurityTone
  /** The chip's accessible name: the words the address speaks of the state (`securityAnnouncement`). */
  name: string
}

/**
 * The verdict for a connection state, or null where the page has no connection to judge (an
 * internal page, an extension's page, a local page, nothing loaded). Under the neutral-secure
 * ruling (§9.19) a secure page shows the closed lock in the surface's deemphasised ink and no
 * verdict word – "secure" is the state of nearly every page – and the glyph speaks only when
 * something is wrong: the open lock in `--v2-warn` for a plain http page (and the HTTPS-only
 * warning that stands in for one), the triangle in `--v2-danger` for a certificate that failed
 * verification (Chrome's dangerous-level glyph; it separates "the site chose http" from "the
 * site's identity failed" at a glance, the two verdicts the sheet tells apart), the shield for a
 * Safe Browsing verdict. Mixed content is the sheet's knowledge (`SiteInfo`), not the pill's:
 * `mixed` opens the lock in the warn ink for the sheet's "Partly secure", and the pill never
 * passes it.
 */
export function securityVerdict(state: IndicatorState, mixed = false): SecurityVerdict | null {
  switch (state) {
    case 'secure':
      return mixed
        ? { glyph: LockOpen, tone: 'warn', name: 'Partly secure' }
        : { glyph: Lock, tone: 'neutral', name: 'Connection is secure' }
    case 'insecure':
      return { glyph: LockOpen, tone: 'warn', name: 'Not secure' }
    case 'certificate-error':
      return { glyph: TriangleAlert, tone: 'danger', name: 'Not secure' }
    case 'dangerous':
      return { glyph: ShieldAlert, tone: 'danger', name: 'Dangerous site' }
    default:
      return null
  }
}

/** The utility class drawing a verdict's ink (the sheet's `toneClass`, shared with the pill); false for the neutral tone, which is the surface's own. */
export function securityToneClass(tone: SecurityTone): string | false {
  return (
    (tone === 'ok' && 'text-[var(--v2-ok)]') ||
    (tone === 'warn' && 'text-[var(--v2-warn)]') ||
    (tone === 'danger' && 'text-[var(--v2-danger)]')
  )
}
