import { describe, expect, it } from 'vitest'
import type { ExtensionInfo, UIState } from '@shared/types'
import {
  PREVIEW_CONTROLS_EXTENSION,
  fontControlsFixture,
  parsePreviewControls,
  previewFontControls
} from '../previewControls'

/*
 * The preview host's `controls=` seed: Settings › Fonts under an extension's control as #500's
 * primitive draws it, staged where nothing publishes a control (this host has no extension store;
 * a device has no `fontSettings` bridge yet), so the phone's held rows and their "Controlled by"
 * row can be looked at and captured for the gate.
 */

const NOW = 1_800_000_000_000

const other = { id: 'other-extension', name: 'Other' } as unknown as ExtensionInfo

function state(over: Partial<UIState> = {}): UIState {
  return {
    capabilities: { extensions: false, genericFontFamilies: false },
    extensions: [],
    extensionControls: {},
    ...over
  } as unknown as UIState
}

describe('parsePreviewControls', () => {
  it('knows the three variants and nothing else', () => {
    expect(parsePreviewControls('fonts')).toBe('fonts')
    expect(parsePreviewControls('size')).toBe('size')
    expect(parsePreviewControls('family')).toBe('family')
    expect(parsePreviewControls(null)).toBeNull()
    expect(parsePreviewControls('')).toBeNull()
    expect(parsePreviewControls('serif')).toBeNull()
  })
})

describe('previewFontControls', () => {
  it('publishes the keys the phone Fonts page reads, each naming the extension and its value in effect', () => {
    const controls = previewFontControls('fonts')
    expect(Object.keys(controls).sort()).toEqual([
      'fonts.minimumSize',
      'fonts.size',
      'fonts.standard'
    ])
    for (const control of Object.values(controls)) {
      expect(control.extensionId).toBe(PREVIEW_CONTROLS_EXTENSION.id)
      expect(control.name).toBe('Advanced Font Settings')
    }
    expect(controls['fonts.standard']?.value).toBe('sans-serif')
    expect(controls['fonts.size']?.value).toBe(18)
    expect(controls['fonts.minimumSize']?.value).toBe(12)
  })

  it('holds one row alone for `size` and `family`, so a lone indicator can be looked at', () => {
    expect(Object.keys(previewFontControls('size'))).toEqual(['fonts.size'])
    expect(Object.keys(previewFontControls('family'))).toEqual(['fonts.standard'])
  })

  it('keeps to the phone’s honest scope: no serif, sans-serif or fixed family, no per-script key', () => {
    for (const variant of ['fonts', 'size', 'family'] as const) {
      for (const key of Object.keys(previewFontControls(variant))) {
        expect(['fonts.standard', 'fonts.size', 'fonts.minimumSize']).toContain(key)
      }
    }
  })
})

describe('fontControlsFixture', () => {
  it('lays the layer over the state: the map, the controlling extension installed, the capability on', () => {
    const next = fontControlsFixture(state(), 'fonts', NOW)
    expect(next.capabilities.extensions).toBe(true)
    expect(next.extensionControls).toEqual(previewFontControls('fonts'))
    expect(next.extensions.map((e) => e.id)).toEqual([PREVIEW_CONTROLS_EXTENSION.id])
    const installed = next.extensions[0]
    expect(installed?.name).toBe('Advanced Font Settings')
    expect(installed?.enabled).toBe(true)
    expect(installed?.permissions).toContain('fontSettings')
    expect(installed?.installedAt).toBeLessThan(NOW)
  })

  it('joins a seeded extension list rather than replacing it, and adds itself once', () => {
    const seeded = state({ extensions: [other] })
    const once = fontControlsFixture(seeded, 'size', NOW)
    expect(once.extensions.map((e) => e.id)).toEqual([
      'other-extension',
      PREVIEW_CONTROLS_EXTENSION.id
    ])
    const twice = fontControlsFixture(once, 'size', NOW)
    expect(twice.extensions).toBe(once.extensions)
  })

  it('keeps a control another layer already holds, adding its own keys beside it', () => {
    const held = state({
      extensionControls: { 'fonts.fixed': { extensionId: 'other-extension', name: 'Other' } }
    })
    const next = fontControlsFixture(held, 'family', NOW)
    expect(next.extensionControls['fonts.fixed']).toEqual({
      extensionId: 'other-extension',
      name: 'Other'
    })
    expect(next.extensionControls['fonts.standard']?.extensionId).toBe(
      PREVIEW_CONTROLS_EXTENSION.id
    )
  })

  it('leaves the rest of the state as it was', () => {
    const before = state({ extensions: [other] })
    const next = fontControlsFixture(before, 'fonts', NOW)
    expect(before.extensions).toEqual([other])
    expect(before.extensionControls).toEqual({})
    expect(before.capabilities.extensions).toBe(false)
    expect(next).not.toBe(before)
  })
})
