// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Laptop, Monitor, MonitorSmartphone, Smartphone, Tablet } from 'lucide-react'
import type { SyncDeviceKind } from '@shared/types'
import { DeviceGlyph, anyDeviceKind } from '../DeviceGlyph'

/*
 * The one device glyph (services pass 4; the #418 ruling 4 and design language v2 §10.4): a
 * device row or heading leads with the kind the device announced – the laptop for a desktop of
 * any OS and for a laptop (Chrome's one "computer" glyph, `GetIconType`), phone, tablet – at the
 * full ink, and a device that announced none with the stand-in at 69 %, the deemphasis a missing
 * favicon's globe takes; a list where no device announced a kind draws no glyph column at all
 * (`anyDeviceKind`, the #453 lead check's condition on §10.4). Every consumer (Settings › Sync's
 * rows, the phone's Send to your devices sheet, the History page's device headings on both
 * layouts, the app menu's Send to Your Devices rows) draws this component and asks this
 * predicate, so what they render and decide is tested once here and each consumer's test checks
 * it is there – and, with no kind in the list, that it is not.
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
  it("draws each kind's lucide glyph – the Laptop for a desktop and for a laptop, Smartphone, Tablet – at the full ink, decorative, named by its kind", () => {
    const expected: Record<SyncDeviceKind, typeof Laptop> = {
      desktop: Laptop,
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
    // The desktop class draws Chrome's one computer glyph, the laptop (`stts_button.cc`'s
    // `GetIconType`: every desktop OS the same picture; the #453 lead check): no host can tell a
    // laptop from a tower, so the monitor is not drawn for either kind until one can. The two
    // kinds still name themselves apart (`data-kind`), so the day a host can, only the picture
    // changes.
    expect(picture(glyphOf('desktop'))).toBe(picture(glyphOf('laptop')))
    expect(picture(glyphOf('desktop'))).not.toBe(picture(lucide(Monitor)))
    expect(glyphOf('desktop')).toContain('data-kind="desktop"')
    expect(glyphOf('laptop')).toContain('data-kind="laptop"')
    // Three pictures for the four kinds; the stand-in a fourth, none of them.
    const pictures = new Set(
      (['desktop', 'laptop', 'phone', 'tablet', null] as const).map((kind) =>
        picture(glyphOf(kind))
      )
    )
    expect(pictures.size).toBe(4)
  })

  it('anyDeviceKind: a list draws a glyph column while any record carries a kind – under either name – and none at all when no record does (§10.4’s condition)', () => {
    // No devices, or devices that all announced none (an older build's peers, whichever field
    // the surface's record keeps the kind in): no column – the labels stand at the gutter rather
    // than behind a column of stand-ins.
    expect(anyDeviceKind([])).toBe(false)
    expect(anyDeviceKind([{}, { kind: undefined }, { kind: null }])).toBe(false)
    expect(anyDeviceKind([{ deviceKind: undefined }, { deviceKind: null }])).toBe(false)
    // One kind among them and every row has the slot: the kinds at the full ink, the rest the
    // stand-in – the same rule for a device list (`kind`) and a tab list (`deviceKind`).
    expect(anyDeviceKind([{ kind: null }, { kind: 'desktop' }])).toBe(true)
    expect(anyDeviceKind([{ deviceKind: undefined }, { deviceKind: 'phone' }])).toBe(true)
    for (const kind of ['desktop', 'laptop', 'phone', 'tablet'] as const) {
      expect(anyDeviceKind([{ kind }]), kind).toBe(true)
      expect(anyDeviceKind([{ deviceKind: kind }]), kind).toBe(true)
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
