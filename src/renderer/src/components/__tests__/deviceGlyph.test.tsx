// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Laptop, Monitor, MonitorSmartphone, Smartphone, Tablet } from 'lucide-react'
import type { SyncDeviceKind } from '@shared/types'
import { DeviceGlyph } from '../DeviceGlyph'

/*
 * The one device glyph (services pass 4; the #418 ruling 4 and design language v2 §10.4): a
 * device row or heading leads with the kind the device announced – monitor, laptop, phone,
 * tablet, Chrome's `GetIconType` mapping – at the full ink, and a device that announced none
 * with the stand-in at 69 %, the deemphasis a missing favicon's globe takes. Every consumer
 * (Settings › Sync's rows, the phone's Send to your devices sheet, the History page's device
 * headings on both layouts, the app menu's Send to Your Devices rows) draws this component, so
 * what it renders is tested once here and each consumer's test checks it is there.
 */

const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
const panels = readFileSync(resolve(__dirname, '../phone/phonePanels.css'), 'utf8')

/** The text of the first `selector {` rule in the stylesheet. */
function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return sheet.slice(at, sheet.indexOf('}', at) + 1)
}

const glyphOf = (kind: SyncDeviceKind | null | undefined): string =>
  renderToStaticMarkup(createElement(DeviceGlyph, { kind }))
const lucide = (Icon: typeof Monitor): string =>
  renderToStaticMarkup(createElement(Icon, { className: 'zen-device-glyph' }))
/** The picture alone: the `<path>`s and shapes, with no attribute of the outer svg. */
const picture = (markup: string): string => markup.slice(markup.indexOf('>') + 1)

describe('DeviceGlyph', () => {
  it("draws each kind's lucide glyph – Monitor, Laptop, Smartphone, Tablet – at the full ink, decorative, named by its kind", () => {
    const expected: Record<SyncDeviceKind, typeof Monitor> = {
      desktop: Monitor,
      laptop: Laptop,
      phone: Smartphone,
      tablet: Tablet
    }
    for (const kind of Object.keys(expected) as SyncDeviceKind[]) {
      const markup = glyphOf(kind)
      expect(picture(markup), kind).toBe(picture(lucide(expected[kind])))
      expect(markup, kind).toContain(`data-kind="${kind}"`)
      expect(markup, kind).toContain('data-testid="device-glyph"')
      expect(markup, kind).toContain('aria-hidden="true"')
      expect(markup, kind).toMatch(/class="[^"]*\bzen-device-glyph\b/)
      expect(markup, kind).not.toContain('zen-list-standin')
    }
  })

  it('draws the stand-in for a device that announced no kind – the monitor-and-phone pair, none of the four – at the 69 % the missing favicon’s globe takes', () => {
    for (const none of [undefined, null]) {
      const markup = glyphOf(none)
      expect(picture(markup)).toBe(picture(lucide(MonitorSmartphone)))
      expect(markup).toContain('data-kind="none"')
      expect(markup).toContain('zen-list-standin')
      expect(markup).toContain('aria-hidden="true"')
    }
    // The stand-in's ink is the one shared class's (phonePanels.css), no utility of its own.
    expect(rule(panels, '.zen-list-standin')).toMatch(/opacity: 0?\.69\b/)
    expect(glyphOf(null)).not.toMatch(/opacity-/)
  })

  it('is sized by the tokens – the icon and its stroke of the layout it stands on – through one class, no literal size', () => {
    const sizing = rule(css, '.zen-device-glyph')
    expect(sizing).toContain('width: var(--v2-icon)')
    expect(sizing).toContain('height: var(--v2-icon)')
    expect(sizing).toContain('stroke-width: var(--v2-icon-stroke)')
    expect(sizing).not.toMatch(/\d+px/)
    // A heading's leading box (`PageGroup.lead`) is the icon's box too, on the rows' favicon column.
    const lead = rule(css, '.zen-page-heading-lead')
    expect(lead).toContain('width: var(--v2-icon)')
    expect(lead).toContain('height: var(--v2-icon)')
  })
})
