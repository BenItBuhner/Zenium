import type { LucideIcon } from 'lucide-react'
import { Cookie, ListChecks, ShieldHalf, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { SiteDataDefault } from '@shared/siteData'
import type { ThirdPartyCookieMode } from '@shared/privacy'

/**
 * The Privacy and security hub (settings-12; the card list at the top of Chrome's Privacy and
 * security page): one card per program of the section, in Chrome's order, each a §10.4 action
 * row – the leading glyph, the title, one line under it – that brings the program's first group
 * on screen (`SectionContext.reveal`, the section's `?group=` landing), trailing the chevron
 * that says so, or opens its dialog, with §9.1's ellipsis on its name and no chevron (the #553
 * lead check's F1 and Q5: a chevron is for a landing, an ellipsis for a dialog). The groups
 * themselves stay where they are under the cards, so the section still reads whole and the
 * search still finds every row; the cards are the desktop and tablet shells' (the phone's
 * Privacy page keeps its plain list, W7-6).
 *
 * Chrome's list is Delete browsing data, Privacy Guide, Third-party cookies, Ad privacy,
 * Security, Site settings, Safety check. Privacy Guide (PS-40) has no page here yet and Ad
 * privacy no engine (no ad topics, no Privacy Sandbox), so neither has a card – an absent
 * feature is not a disabled card. Two names are the house's own: the first card follows the
 * dialog it opens, "Clear browsing data" today (one name for one thing – the F1 ruling; the
 * family's rename to Chrome's "Delete browsing data", the dialog, History's opener, the app
 * menu row and this card together, is a slice of its own), and the third names its landing,
 * "Safe Browsing", since the nav already has a Security category (F3 / Q4).
 */
export interface PrivacyHubCard {
  /** The row id, `hub-` prefixed so it stays unique beside the section's other programs. */
  id: string
  label: string
  glyph: LucideIcon
  /**
   * The group of the section the card lands on (`RowGroup.id`); null for the card whose press
   * opens a dialog instead (Clear browsing data, the PS-13 sheet).
   */
  group: string | null
}

export const PRIVACY_HUB_CARDS: readonly PrivacyHubCard[] = [
  { id: 'hub-clear-data', label: 'Clear browsing data…', glyph: Trash2, group: null },
  { id: 'hub-cookies', label: 'Third-party cookies', glyph: Cookie, group: 'site-data' },
  { id: 'hub-security', label: 'Safe Browsing', glyph: ShieldHalf, group: 'safe-browsing' },
  {
    id: 'hub-site-settings',
    label: 'Site settings',
    glyph: SlidersHorizontal,
    group: 'sites-permissions'
  },
  // Lucide's `list-checks`: a check over a list – the nav's Security keeps `shield-check`.
  { id: 'hub-safety-check', label: 'Safety check', glyph: ListChecks, group: 'safety-check' }
]

/**
 * The one line under each card's title: Chrome's, in the house's words. Safety check's "data
 * breaches" is what the check does: its Passwords row reads Password Checkup's compromised
 * count, looked up in Have I Been Pwned's Pwned Passwords corpus by k-anonymity range
 * (`core/credentials/checkup.ts`), kept live by the sign-in leak check (`leak.ts`) – the #553
 * lead check's Q8.
 */
export const PRIVACY_HUB_LINES = {
  clearData: 'Delete history, cookies, cache and more',
  security: 'Safe Browsing (protection from dangerous sites) and other security settings',
  siteSettings: 'What sites may use and show (location, camera, pop-ups and more)',
  safetyCheck: 'Zenium can help keep you safe from data breaches, bad extensions and more'
} as const

/**
 * The Third-party cookies card's line states the setting, as Chrome's does ("Third-party
 * cookies are blocked in Incognito mode"): the site-data default, and – under the middle
 * choice – where the block applies, the private contexts alone or everywhere. The words follow
 * the host's private windows or private tabs.
 */
export function thirdPartyCookiesLine(
  siteDataDefault: SiteDataDefault,
  mode: ThirdPartyCookieMode,
  windows: boolean
): string {
  switch (siteDataDefault) {
    case 'allow':
      return 'Third-party cookies are allowed'
    case 'block-all':
      return 'All cookies are blocked'
    case 'block-third-party':
      return mode === 'block-private'
        ? `Third-party cookies are blocked in private ${windows ? 'windows' : 'tabs'}`
        : 'Third-party cookies are blocked'
  }
}
