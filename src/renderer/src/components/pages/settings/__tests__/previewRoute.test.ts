import { describe, expect, it } from 'vitest'
import { internalPageUrl, parseInternalPageUrl } from '@shared/internalPages'
import { previewRouteOf } from '../previewRoute'

/*
 * The Settings tab's card draws the route its address names (`SettingsPreview`, the stand-in
 * until the host's picture of the page arrives): the landing for `zen://settings`, the drill-in
 * the tab is on for a section or a section's page – never the landing for a tab that is not on
 * it, which is what the card said before, whatever the tab's address. The address is the tab's
 * whole state here (Chrome's model: `zen://settings/<section>[/<page>]`, the section beneath
 * the page in history), so the round trip through `parseInternalPageUrl` / `internalPageUrl`
 * is pinned beside it: what `page.navigate` writes is what the card and the restore read.
 */

describe('the route a Settings card draws', () => {
  it('is the landing for the page itself', () => {
    expect(previewRouteOf('zen://settings')).toEqual({
      title: 'Settings',
      drillIn: null,
      landing: true
    })
    expect(previewRouteOf('zenium://settings/')).toEqual({
      title: 'Settings',
      drillIn: null,
      landing: true
    })
  })

  it('is the section the tab is on, by its label', () => {
    expect(previewRouteOf('zen://settings/updates')).toEqual({
      title: 'Settings',
      drillIn: 'Updates',
      landing: false
    })
    expect(previewRouteOf('zen://settings/privacy')?.drillIn).toBe('Privacy and Security')
  })

  it("is the section's drill-in page when the address names one, by the page's label", () => {
    expect(previewRouteOf('zen://settings/privacy/site-data')).toEqual({
      title: 'Settings',
      drillIn: 'Site data',
      landing: false
    })
    // The page's parameters ride in the address and change nothing of the drawing.
    expect(previewRouteOf('zen://settings/privacy/site-data?site=news.example')?.drillIn).toBe(
      'Site data'
    )
  })

  it('reads an unknown section as the landing and an unknown page as its section, as the page does', () => {
    expect(previewRouteOf('zen://settings/no-such-section')?.landing).toBe(true)
    expect(previewRouteOf('zen://settings/privacy/no-such-page')?.drillIn).toBe(
      'Privacy and Security'
    )
  })

  it('names another chrome page by its title, with no landing rows to draw', () => {
    expect(previewRouteOf('zen://history')).toEqual({
      title: 'History',
      drillIn: null,
      landing: false
    })
  })

  it('is nothing for an address that is not a page', () => {
    expect(previewRouteOf('https://example.com/settings')).toBeNull()
    expect(previewRouteOf('zen://error?code=-105')).toBeNull()
  })
})

describe('the address a Settings route travels as', () => {
  it('carries the section and the drill-in page as path segments, and comes back the same', () => {
    const ref = parseInternalPageUrl('zen://settings/privacy/site-data')
    expect(ref).toEqual({ id: 'settings', section: 'privacy', subpage: 'site-data' })
    expect(internalPageUrl(ref!)).toBe('zen://settings/privacy/site-data')
    expect(internalPageUrl({ id: 'settings', section: 'updates' })).toBe('zen://settings/updates')
    expect(internalPageUrl({ id: 'settings', section: null })).toBe('zen://settings')
  })

  it("keeps a drill-in page's parameters through the round trip", () => {
    const url = internalPageUrl({
      id: 'settings',
      section: 'privacy',
      subpage: 'site-data',
      query: { site: 'news.example' }
    })
    expect(url).toBe('zen://settings/privacy/site-data?site=news.example')
    expect(parseInternalPageUrl(url)).toEqual({
      id: 'settings',
      section: 'privacy',
      subpage: 'site-data',
      query: { site: 'news.example' }
    })
  })
})
