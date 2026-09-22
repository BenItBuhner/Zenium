import { describe, expect, it } from 'vitest'
import { schemeForPages } from '../pageScheme'

/**
 * The scheme the host is handed for the pages' night mode (`chrome.setTheme`, `Host.applyTheme`
 * -> `PageTheme.nightMode`) follows the chrome's paint, not the setting the moment it changes.
 */
describe('the scheme handed to the host for the pages', () => {
  it('is the setting before anything was handed over (boot)', () => {
    expect(schemeForPages(null, 'light', false, false)).toBe('light')
    expect(schemeForPages(null, 'dark', false, false)).toBe('dark')
    expect(schemeForPages(null, 'system', true, true)).toBe('system')
  })

  // Light -> Dark: the state changes a blend ahead of the colours; the root is still light.
  it('holds the scheme it has until the paint crosses to the new side', () => {
    expect(schemeForPages('light', 'dark', false, false)).toBe('light')
  })

  it('hands the new scheme over as the paint crosses (the blend’s midpoint, or a cut)', () => {
    expect(schemeForPages('light', 'dark', true, false)).toBe('dark')
    expect(schemeForPages('dark', 'light', false, false)).toBe('light')
  })

  // The paint already shows the side the setting asks for: nothing to wait for.
  it('hands a scheme over at once when the root already paints its side', () => {
    // Dark -> System on a dark system: the colours stay; the host follows the system from now.
    expect(schemeForPages('dark', 'system', true, true)).toBe('system')
    // System (light) -> Light: the same colours, the host pinned to light.
    expect(schemeForPages('system', 'light', false, false)).toBe('light')
  })

  it('reads system as the side the chrome’s media query shows', () => {
    // Light -> System on a dark system: the chrome blends to dark first.
    expect(schemeForPages('light', 'system', false, true)).toBe('light')
    expect(schemeForPages('light', 'system', true, true)).toBe('system')
  })

  // MOT-14: a private tab in view paints dark whatever the setting.
  it('waits behind a private surface and follows the chrome back out of it', () => {
    // Dark -> Light under the private surface: the root stays dark, the pages keep dark.
    expect(schemeForPages('dark', 'light', true, false)).toBe('dark')
    // The private tab left, the chrome blends to light: handed over at the crossing.
    expect(schemeForPages('dark', 'light', false, false)).toBe('light')
    // Light -> Dark under the private surface: the root is dark already, handed over at once.
    expect(schemeForPages('light', 'dark', true, false)).toBe('dark')
  })
})
