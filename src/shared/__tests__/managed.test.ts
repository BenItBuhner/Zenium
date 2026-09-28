import { describe, expect, it } from 'vitest'
import {
  MANAGED_BY_MAX,
  MANAGED_KEYS_MAX,
  MANAGED_KEY_MAX,
  MANAGED_MENU_LABEL,
  MANAGEMENT_PAGE_TITLE,
  isManaged,
  managedStatusOf,
  managementHeading,
  managementNotice,
  unmanaged
} from '../managed'

/*
 * The managed browser's model (TB-13): Chrome's rule that any restriction at all makes the
 * browser managed, the host's reply checked into a status, and the page's sentences – Chrome's
 * where Chrome has them, an honest one where Chrome's would promise what Zenium does not do.
 */

describe('isManaged', () => {
  it("is Chrome's `IsBrowserManaged`: any key makes the browser managed; none, an unread status or no status does not", () => {
    expect(isManaged({ by: null, keys: ['URLBlocklist'] })).toBe(true)
    expect(isManaged({ by: 'Example Corp', keys: ['EnterpriseCustomLabel'] })).toBe(true)
    expect(isManaged({ by: null, keys: [] })).toBe(false)
    expect(isManaged(unmanaged())).toBe(false)
    expect(isManaged(null)).toBe(false)
    expect(isManaged(undefined)).toBe(false)
    // A name alone names nobody: the keys are the fact.
    expect(isManaged({ by: 'Example Corp', keys: [] })).toBe(false)
  })
})

describe('managedStatusOf', () => {
  it('checks the host’s reply field by field: the keys trimmed, deduplicated and sorted, the name trimmed, an empty name null', () => {
    expect(
      managedStatusOf({
        by: '  Example Corp ',
        keys: ['URLBlocklist', ' HomepageLocation', 'URLBlocklist', 'EnterpriseCustomLabel']
      })
    ).toEqual({
      by: 'Example Corp',
      keys: ['EnterpriseCustomLabel', 'HomepageLocation', 'URLBlocklist']
    })
    expect(managedStatusOf({ by: '   ', keys: ['URLBlocklist'] })).toEqual({
      by: null,
      keys: ['URLBlocklist']
    })
  })

  it('reads anything that is not a status as unmanaged: a doubtful read never shows a row', () => {
    for (const value of [
      null,
      undefined,
      'managed',
      7,
      [],
      {},
      { keys: 'URLBlocklist' },
      { by: 3 }
    ]) {
      expect(managedStatusOf(value), JSON.stringify(value)).toEqual({ by: null, keys: [] })
    }
    // Keys that are not strings, or blank, are dropped; a name with no key names nobody.
    expect(managedStatusOf({ by: 'Example Corp', keys: [1, '', '  ', null] })).toEqual({
      by: null,
      keys: []
    })
  })

  it('cuts what no administrator typed: over-long keys dropped, the list and the name capped', () => {
    const long = 'K'.repeat(MANAGED_KEY_MAX + 1)
    const many = Array.from(
      { length: MANAGED_KEYS_MAX + 5 },
      (_, i) => `Key${String(i).padStart(4, '0')}`
    )
    const status = managedStatusOf({ by: 'N'.repeat(MANAGED_BY_MAX + 10), keys: [long, ...many] })
    expect(status.keys).toHaveLength(MANAGED_KEYS_MAX)
    expect(status.keys).not.toContain(long)
    expect(status.keys[0]).toBe('Key0000')
    expect(status.by).toHaveLength(MANAGED_BY_MAX)
  })
})

describe('the page’s sentences', () => {
  it("are Chrome's management strings in the house's spelling: the subtitle for a named manager, for an unnamed one, and for a browser that is not managed", () => {
    expect(managementHeading({ by: 'example.com', keys: ['URLBlocklist'] })).toBe(
      'Your browser is managed by example.com'
    )
    expect(managementHeading({ by: null, keys: ['URLBlocklist'] })).toBe(
      'Your browser is managed by your organisation'
    )
    expect(managementHeading(unmanaged())).toBe('Your browser is not managed')
    // A name with no key is no manager: the unmanaged sentence, as `isManaged` reads it.
    expect(managementHeading({ by: 'example.com', keys: [] })).toBe('Your browser is not managed')
  })

  it("say what Zenium does: Chrome's not-managed notice with the product's name; for a managed browser, that the configuration is read and listed, not applied", () => {
    expect(managementNotice(unmanaged())).toBe(
      'This browser is not managed by a company or other organisation. Activity on this device may be managed outside of Zenium.'
    )
    const managed = managementNotice({ by: null, keys: ['URLBlocklist'] })
    expect(managed).toContain('does not apply them yet')
    expect(managed).toContain('Activity on this device may also be managed outside of Zenium.')
    expect(managed).not.toContain('remotely')
  })

  it("name the row and the page as Chrome for Android does: `IDS_MANAGED_BROWSER` in the menus' Title Case, `IDS_MANAGEMENT`", () => {
    expect(MANAGED_MENU_LABEL).toBe('Managed Browser')
    expect(MANAGEMENT_PAGE_TITLE).toBe('Management')
  })
})
