import { describe, expect, it, vi } from 'vitest'
import type { LayeredFonts } from '@core/extensions/api/fontSettings'
import type { State } from '@core/state'
import type { ExtensionControl } from '@shared/types'
import { SettingControls, fontControlsOf, type SettingControlsSink } from '../settingControls'

/*
 * The Android seam under #500's controlled-setting rows: the merged map of the settings the
 * extensions hold, published to the core's state once per change, and the `fontSettings`
 * layer's translation into the Fonts page's keys. Nothing calls it on the device yet – the
 * WebView `chrome.fontSettings` bridge is the extensions program's – so the seam's contract is
 * pinned here for that bridge to meet.
 */

// The core's `State` is the sink: `setExtensionControls` as #500 gave it (a compile-time pin).
const stateIsASink = (state: State): SettingControlsSink => state
void stateIsASink

const held = (
  extensionId: string,
  name: string,
  value?: string | number | boolean
): ExtensionControl => ({ extensionId, name, ...(value === undefined ? {} : { value }) })

function sink(): SettingControlsSink & { setExtensionControls: ReturnType<typeof vi.fn> } {
  return { setExtensionControls: vi.fn() }
}

const USER_FONTS: LayeredFonts['fonts'] = {
  standard: null,
  serif: null,
  sansSerif: null,
  fixed: null,
  size: 16,
  minimumSize: 0
}

const NO_ONE: LayeredFonts['controllers'] = {
  standard: null,
  serif: null,
  sansSerif: null,
  fixed: null,
  size: null,
  minimumSize: null
}

function layered(over: {
  fonts?: Partial<LayeredFonts['fonts']>
  controllers?: Partial<LayeredFonts['controllers']>
}): LayeredFonts {
  return {
    fonts: { ...USER_FONTS, ...over.fonts },
    controllers: { ...NO_ONE, ...over.controllers },
    layer: { families: {}, scripts: {}, fixedSize: null, controllers: {} }
  }
}

const names: Record<string, string> = {
  afs: 'Advanced Font Settings',
  dr: 'Dark Reader'
}
const nameOf = (id: string): string => names[id] ?? id

describe('SettingControls', () => {
  it('hands the sink one API’s map as published, and nothing while nothing is held', () => {
    const s = sink()
    const controls = new SettingControls(s)
    controls.publish('fontSettings', {})
    expect(s.setExtensionControls).not.toHaveBeenCalled()
    expect(controls.current).toEqual({})

    controls.publish('fontSettings', { 'fonts.size': held('afs', 'Advanced Font Settings', 18) })
    expect(s.setExtensionControls).toHaveBeenCalledTimes(1)
    expect(s.setExtensionControls).toHaveBeenLastCalledWith({
      'fonts.size': held('afs', 'Advanced Font Settings', 18)
    })
    expect(controls.current).toEqual({ 'fonts.size': held('afs', 'Advanced Font Settings', 18) })
  })

  it('merges every API’s map, so one API’s re-publish never drops another’s keys', () => {
    const s = sink()
    const controls = new SettingControls(s)
    controls.publish('fontSettings', { 'fonts.size': held('afs', 'Advanced Font Settings', 18) })
    controls.publish('privacy', { 'privacy.doNotTrack': held('dr', 'Dark Reader', true) })
    expect(s.setExtensionControls).toHaveBeenLastCalledWith({
      'fonts.size': held('afs', 'Advanced Font Settings', 18),
      'privacy.doNotTrack': held('dr', 'Dark Reader', true)
    })

    controls.publish('fontSettings', {
      'fonts.standard': held('afs', 'Advanced Font Settings', 'serif')
    })
    expect(s.setExtensionControls).toHaveBeenLastCalledWith({
      'fonts.standard': held('afs', 'Advanced Font Settings', 'serif'),
      'privacy.doNotTrack': held('dr', 'Dark Reader', true)
    })
    expect(s.setExtensionControls).toHaveBeenCalledTimes(3)
  })

  it('lets go of an API’s layer on an empty map: the rows stand free again', () => {
    const s = sink()
    const controls = new SettingControls(s)
    controls.publish('fontSettings', {
      'fonts.size': held('afs', 'Advanced Font Settings', 18),
      'fonts.minimumSize': held('afs', 'Advanced Font Settings', 12)
    })
    controls.publish('fontSettings', {})
    expect(s.setExtensionControls).toHaveBeenLastCalledWith({})
    expect(controls.current).toEqual({})
    expect(s.setExtensionControls).toHaveBeenCalledTimes(2)
  })

  it('stops a publish that moves nothing: the same keys, holders and values', () => {
    const s = sink()
    const controls = new SettingControls(s)
    const map = (): Record<string, ExtensionControl> => ({
      'fonts.size': held('afs', 'Advanced Font Settings', 18),
      'fonts.standard': held('afs', 'Advanced Font Settings')
    })
    controls.publish('fontSettings', map())
    controls.publish('fontSettings', map())
    controls.publish('fontSettings', map())
    expect(s.setExtensionControls).toHaveBeenCalledTimes(1)
  })

  it('re-publishes when the value alone moves: the held row shows the value in effect', () => {
    const s = sink()
    const controls = new SettingControls(s)
    controls.publish('fontSettings', { 'fonts.size': held('afs', 'Advanced Font Settings', 18) })
    controls.publish('fontSettings', { 'fonts.size': held('afs', 'Advanced Font Settings', 20) })
    expect(s.setExtensionControls).toHaveBeenCalledTimes(2)
    expect(s.setExtensionControls).toHaveBeenLastCalledWith({
      'fonts.size': held('afs', 'Advanced Font Settings', 20)
    })
  })

  it('re-publishes when the holder or its name moves, and when a value is let go of', () => {
    const s = sink()
    const controls = new SettingControls(s)
    controls.publish('fontSettings', { 'fonts.size': held('afs', 'Advanced Font Settings', 18) })
    controls.publish('fontSettings', { 'fonts.size': held('dr', 'Dark Reader', 18) })
    controls.publish('fontSettings', { 'fonts.size': held('dr', 'Dark Reader (beta)', 18) })
    controls.publish('fontSettings', { 'fonts.size': held('dr', 'Dark Reader (beta)') })
    expect(s.setExtensionControls).toHaveBeenCalledTimes(4)
  })

  it('does not hand the sink a map it keeps mutating afterwards', () => {
    const s = sink()
    const controls = new SettingControls(s)
    controls.publish('fontSettings', { 'fonts.size': held('afs', 'Advanced Font Settings', 18) })
    const first = s.setExtensionControls.mock.calls[0]?.[0] as Record<string, ExtensionControl>
    controls.publish('privacy', { 'privacy.doNotTrack': held('dr', 'Dark Reader', true) })
    expect(Object.keys(first)).toEqual(['fonts.size'])
  })
})

describe('fontControlsOf', () => {
  it('keys every preference an extension holds by the Fonts page’s name for it, with the value in effect', () => {
    const controls = fontControlsOf(
      layered({
        fonts: { standard: 'sans-serif', size: 18, minimumSize: 12 },
        controllers: { standard: 'afs', size: 'afs', minimumSize: 'dr' }
      }),
      nameOf
    )
    expect(controls).toEqual({
      'fonts.standard': held('afs', 'Advanced Font Settings', 'sans-serif'),
      'fonts.size': held('afs', 'Advanced Font Settings', 18),
      'fonts.minimumSize': held('dr', 'Dark Reader', 12)
    })
  })

  it('leaves a preference the user holds out, whatever its value', () => {
    const controls = fontControlsOf(
      layered({ fonts: { size: 22, standard: 'serif' }, controllers: { size: 'afs' } }),
      nameOf
    )
    expect(Object.keys(controls)).toEqual(['fonts.size'])
  })

  it('gives a held family the engine resolves itself (null) no value, so the row keeps to the setting', () => {
    const controls = fontControlsOf(
      layered({ fonts: { standard: null }, controllers: { standard: 'afs' } }),
      nameOf
    )
    expect(controls['fonts.standard']).toEqual(held('afs', 'Advanced Font Settings'))
    expect('value' in (controls['fonts.standard'] ?? {})).toBe(false)
  })

  it('carries the six preferences when six are held – the desktop’s rows; the phone draws its three', () => {
    const controls = fontControlsOf(
      layered({
        fonts: { standard: 'a', serif: 'b', sansSerif: 'c', fixed: 'd', size: 18, minimumSize: 12 },
        controllers: {
          standard: 'afs',
          serif: 'afs',
          sansSerif: 'afs',
          fixed: 'afs',
          size: 'afs',
          minimumSize: 'afs'
        }
      }),
      nameOf
    )
    expect(Object.keys(controls).sort()).toEqual([
      'fonts.fixed',
      'fonts.minimumSize',
      'fonts.sansSerif',
      'fonts.serif',
      'fonts.size',
      'fonts.standard'
    ])
  })

  it('is empty for no layer, and publishFonts(null) lets the layer go', () => {
    expect(fontControlsOf(null, nameOf)).toEqual({})
    const s = sink()
    const controls = new SettingControls(s)
    controls.publishFonts(layered({ fonts: { size: 18 }, controllers: { size: 'afs' } }), nameOf)
    expect(s.setExtensionControls).toHaveBeenLastCalledWith({
      'fonts.size': held('afs', 'Advanced Font Settings', 18)
    })
    controls.publishFonts(null, nameOf)
    expect(s.setExtensionControls).toHaveBeenLastCalledWith({})
  })
})
