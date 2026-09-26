import { describe, expect, it } from 'vitest'
import { PRIVACY_HUB_CARDS, PRIVACY_HUB_LINES, thirdPartyCookiesLine } from '../privacyHub'

/*
 * The Privacy and security hub's card list (W7-6, settings-12): Chrome's cards in Chrome's
 * order, each naming the group it lands on – or the dialog it opens – and the Third-party
 * cookies card's line reading the setting.
 */

describe('the Privacy and security hub cards', () => {
  it('are Chrome’s, in Chrome’s order, without Privacy Guide and Ad privacy (no page, no engine)', () => {
    expect(PRIVACY_HUB_CARDS.map((c) => c.label)).toEqual([
      'Delete browsing data',
      'Third-party cookies',
      'Security',
      'Site settings',
      'Safety check'
    ])
    expect(PRIVACY_HUB_CARDS.map((c) => c.label)).not.toContain('Privacy Guide')
    expect(PRIVACY_HUB_CARDS.map((c) => c.label)).not.toContain('Ad privacy')
  })

  it('name the group each lands on, the Delete browsing data card its dialog instead', () => {
    expect(PRIVACY_HUB_CARDS.map((c) => [c.id, c.group])).toEqual([
      ['hub-clear-data', null],
      ['hub-cookies', 'site-data'],
      ['hub-security', 'safe-browsing'],
      ['hub-site-settings', 'sites-permissions'],
      ['hub-safety-check', 'safety-check']
    ])
    // Every id is unique and `hub-` prefixed, beside the section's other programs' row ids.
    const ids = PRIVACY_HUB_CARDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('hub-'))).toBe(true)
    for (const card of PRIVACY_HUB_CARDS) expect(typeof card.glyph).not.toBe('undefined')
  })

  it('have one line each, Chrome’s in the house’s words (no Oxford comma)', () => {
    for (const line of Object.values(PRIVACY_HUB_LINES)) {
      expect(line).not.toMatch(/, and /)
      expect(line.endsWith('.')).toBe(false)
    }
    expect(PRIVACY_HUB_LINES.clearData).toBe('Delete history, cookies, cache and more')
    expect(PRIVACY_HUB_LINES.safetyCheck).toBe(
      'Zenium can help keep you safe from data breaches, bad extensions and more'
    )
  })

  it('state the Third-party cookies setting on its card, in the host’s words for private contexts', () => {
    expect(thirdPartyCookiesLine('allow', 'allow', true)).toBe('Third-party cookies are allowed')
    expect(thirdPartyCookiesLine('block-all', 'block', true)).toBe('All cookies are blocked')
    expect(thirdPartyCookiesLine('block-third-party', 'block', true)).toBe(
      'Third-party cookies are blocked'
    )
    expect(thirdPartyCookiesLine('block-third-party', 'block-private', true)).toBe(
      'Third-party cookies are blocked in private windows'
    )
    expect(thirdPartyCookiesLine('block-third-party', 'block-private', false)).toBe(
      'Third-party cookies are blocked in private tabs'
    )
  })
})
