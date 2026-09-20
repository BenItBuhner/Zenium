import { describe, expect, it } from 'vitest'
import { securityIndicator } from '@shared/siteInfo'
import { closeTabLabel, groupCardLabel, tabCardLabel } from '../overviewLabels'
import { phoneAddressLabel, securityAnnouncement } from '../pillLabel'

// What TalkBack hears (A11Y-01): the phone pill's address with the connection's state, the
// overview's cards with their place among the pane's tabs, the groups with their count.
describe('the phone pill address label', () => {
  it('speaks the connection state after the address, from OMN-02 indicator', () => {
    expect(phoneAddressLabel('example.com', securityIndicator('https://example.com/', null))).toBe(
      'Address, example.com, Connection is secure'
    )
    expect(phoneAddressLabel('example.com', securityIndicator('http://example.com/', null))).toBe(
      'Address, example.com, Not secure'
    )
    expect(phoneAddressLabel('example.com', securityIndicator('https://example.com/', -201))).toBe(
      'Address, example.com, Not secure'
    )
    expect(phoneAddressLabel('Settings', securityIndicator('zen://settings', null))).toBe(
      'Address, Settings, Zenium page'
    )
    expect(phoneAddressLabel('notes.txt', securityIndicator('file:///tmp/notes.txt', null))).toBe(
      'Address, notes.txt, Local file'
    )
  })

  it('does not repeat a state that is all the address says, and says nothing of an empty pill', () => {
    const extension = securityIndicator(
      'chrome-extension://dbepggeogbaibhgnhhndojpepiihcmeb/options.html',
      null
    )
    expect(securityAnnouncement(extension)).toBe('Extension page')
    expect(phoneAddressLabel('Extension page', extension)).toBe('Address, Extension page')
    expect(phoneAddressLabel('Vimium', extension)).toBe('Address, Vimium, Extension page')
    expect(phoneAddressLabel('', securityIndicator('', null))).toBe('Search or enter address')
    expect(securityAnnouncement(securityIndicator('', null))).toBeNull()
    expect(phoneAddressLabel('example.com', null)).toBe('Address, example.com')
  })

  it('names the space after the state when the window has more than one', () => {
    expect(
      phoneAddressLabel('example.com', securityIndicator('https://example.com/', null), 'Work')
    ).toBe('Address, example.com, Connection is secure, in Work')
  })
})

describe('the overview labels', () => {
  it('composes a card as title, place and count, then "current" for the shown tab', () => {
    expect(tabCardLabel('Zenium', 2, 7)).toBe('Zenium, tab 2 of 7')
    expect(tabCardLabel('Zenium', 1, 1, true)).toBe('Zenium, tab 1 of 1, current')
    expect(closeTabLabel('Zenium')).toBe('Close Zenium')
  })

  it('names a group with its count, or "Tab group" when it has no name', () => {
    expect(groupCardLabel('Research', 3)).toBe('Research, tab group, 3 tabs')
    expect(groupCardLabel('Research', 1)).toBe('Research, tab group, 1 tab')
    expect(groupCardLabel('  ', 2)).toBe('Tab group, 2 tabs')
  })
})
