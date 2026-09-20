import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DPI,
  displayUnitInfo,
  displayUnitInfos,
  normalizeRotation,
  SYSTEM_DISPLAY_CROS_ONLY_METHODS,
  type ScreenDisplay
} from '../api/systemDisplay'
import { API_SPEC } from '../api/spec'

const laptop: ScreenDisplay = {
  id: 2528732444,
  label: 'Built-in Retina Display',
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 38, width: 1512, height: 944 },
  scaleFactor: 2,
  rotation: 0,
  internal: true,
  touchSupport: 'unavailable',
  accelerometerSupport: 'unknown'
}

const monitor: ScreenDisplay = {
  id: 724156409,
  label: 'DELL U2723QE',
  bounds: { x: 1512, y: -200, width: 3840, height: 2160 },
  workArea: { x: 1512, y: -200, width: 3840, height: 2160 },
  scaleFactor: 1.5,
  rotation: 90,
  internal: false,
  touchSupport: 'available',
  accelerometerSupport: 'unavailable'
}

describe('chrome.system.display info', () => {
  it('is Chrome\u2019s DisplayUnitInfo: string id, DPI from the scale factor, bounds and work area', () => {
    expect(displayUnitInfo(laptop, laptop.id)).toEqual({
      id: '2528732444',
      name: 'Built-in Retina Display',
      mirroringSourceId: '',
      mirroringDestinationIds: [],
      isPrimary: true,
      isInternal: true,
      isEnabled: true,
      isUnified: false,
      activeState: 'active',
      dpiX: 2 * DEFAULT_DPI,
      dpiY: 2 * DEFAULT_DPI,
      rotation: 0,
      bounds: { left: 0, top: 0, width: 1512, height: 982 },
      overscan: { left: 0, top: 0, right: 0, bottom: 0 },
      workArea: { left: 0, top: 38, width: 1512, height: 944 },
      modes: [],
      hasTouchSupport: false,
      hasAccelerometerSupport: false,
      availableDisplayZoomFactors: [],
      displayZoomFactor: 1
    })
  })

  it('flags only the primary display and reports touch, rotation and negative origins', () => {
    const infos = displayUnitInfos([laptop, monitor], laptop.id)
    expect(infos.map((info) => [info.id, info.isPrimary])).toEqual([
      ['2528732444', true],
      ['724156409', false]
    ])
    const second = infos[1]
    expect(second.bounds).toEqual({ left: 1512, top: -200, width: 3840, height: 2160 })
    expect(second.rotation).toBe(90)
    expect(second.hasTouchSupport).toBe(true)
    expect(second.isInternal).toBe(false)
    expect(second.dpiX).toBe(144)
  })

  it('has no primary when the screen names none', () => {
    expect(displayUnitInfos([laptop], null).map((info) => info.isPrimary)).toEqual([false])
  })

  it('reports rotations as Chrome does: 0, 90, 180, 270, anything else 0', () => {
    expect([0, 90, 180, 270, 45, -90, NaN].map(normalizeRotation)).toEqual([
      0, 90, 180, 270, 0, 0, 0
    ])
  })

  it('is in the spec behind the system.display permission with getInfo, getDisplayLayout, the ChromeOS-only functions and onDisplayChanged', () => {
    const ns = API_SPEC['system.display']
    expect(ns.permissions).toEqual(['system.display'])
    expect(Object.keys(ns.methods).sort()).toEqual(
      ['getInfo', 'getDisplayLayout', ...SYSTEM_DISPLAY_CROS_ONLY_METHODS].sort()
    )
    expect(Object.keys(ns.events)).toEqual(['onDisplayChanged'])
    expect(ns.constants?.MirrorMode).toEqual({ OFF: 'off', NORMAL: 'normal', MIXED: 'mixed' })
  })
})
