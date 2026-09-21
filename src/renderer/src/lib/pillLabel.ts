import type { SecurityIndicator } from '@shared/siteInfo'

/**
 * What a screen reader hears about the connection after the address, from the pill's indicator
 * (`securityIndicator`, the core's word on a tab). The desktop pill draws the state – the lock,
 * the "Not secure" text, the page glyph; the phone pill draws a lock or nothing, so it speaks the
 * state instead (A11Y-01 on OMN-02): "Connection is secure", "Not secure", "Zenium page",
 * "Extension page", "Local file". Nothing while there is no site to speak of.
 */
export function securityAnnouncement(indicator: SecurityIndicator): string | null {
  if (indicator.label) return indicator.label
  if (indicator.state === 'empty' || indicator.state === 'unknown') return null
  return indicator.title.split(' · ')[0] ?? null
}

/**
 * The phone pill's address button as TalkBack reads it: "Address, <host>, <state>" – the host as
 * the pill shows it (the site, an internal page's name, an extension's), then the connection's
 * state, then the states of the chips the site-information sheet carries for the pill
 * ("5 requests blocked", "Translation offered"; v2 §9.29 on the phone, OMN-02: the pill draws
 * no chip for them, so its one stop tells what the sheet would show), then the space's name
 * when the window has more than one (the pill's own space label is decoration to the tree, the
 * group it sits in being no stop of its own). A pill with nothing in it is the field's
 * placeholder. The state is not repeated when it is all the address says ("Extension page" for
 * an extension the chrome does not know); an empty chip state adds nothing.
 */
export function phoneAddressLabel(
  address: string,
  indicator: SecurityIndicator | null,
  spaceName: string | null = null,
  chipStates: readonly string[] = []
): string {
  if (!address) return 'Search or enter address'
  const parts = ['Address', address]
  const state = indicator ? securityAnnouncement(indicator) : null
  if (state && state !== address) parts.push(state)
  for (const chipState of chipStates) if (chipState) parts.push(chipState)
  if (spaceName) parts.push(`in ${spaceName}`)
  return parts.join(', ')
}
