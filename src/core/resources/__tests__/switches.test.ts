import { describe, expect, it } from 'vitest'
import {
  BASELINE_DISABLED_FEATURES,
  baselineDisabledFeatures,
  deriveStartupProfile,
  profilesDiffer,
  sanitizeResourceSettings,
  serializeProfile,
  startupSwitches
} from '../switches'
import { DEFAULT_RESOURCE_SETTINGS } from '../../../shared/defaults'
import type { ResourceSettings } from '../../../shared/types'

function settings(overrides: Partial<ResourceSettings> = {}): ResourceSettings {
  return { ...structuredClone(DEFAULT_RESOURCE_SETTINGS), ...overrides }
}

const names = (s: ResourceSettings): string[] => deriveStartupProfile(s).switches.map((x) => x.name)

describe('deriveStartupProfile', () => {
  it('derives nothing when the governor is off', () => {
    expect(deriveStartupProfile(settings({ enabled: false }))).toEqual({
      switches: [],
      hardwareAcceleration: true
    })
  })

  it('turns the process profile into Chromium and V8 switches', () => {
    const profile = deriveStartupProfile(
      settings({
        process: {
          rendererProcessLimit: 6,
          rendererHeapMb: 512,
          lowEndDeviceMode: true,
          disableSpareRenderer: true,
          disableBackForwardCache: true,
          disablePrerender: true,
          rasterThreads: 2,
          v8OptimizeForSize: true
        }
      })
    )
    expect(profile.switches).toEqual([
      { name: 'renderer-process-limit', value: '6' },
      { name: 'enable-low-end-device-mode' },
      { name: 'num-raster-threads', value: '2' },
      { name: 'js-flags', value: '--max-old-space-size=512 --optimize-for-size' },
      {
        name: 'disable-features',
        value: 'SpareRendererForSitePerProcess,BackForwardCache,Prerender2'
      }
    ])
    expect(profile.hardwareAcceleration).toBe(true)
  })

  it('clamps out-of-range process values', () => {
    const profile = deriveStartupProfile(
      settings({
        process: {
          ...DEFAULT_RESOURCE_SETTINGS.process,
          rendererProcessLimit: 999,
          rasterThreads: 99
        }
      })
    )
    expect(profile.switches).toContainEqual({ name: 'renderer-process-limit', value: '64' })
    expect(profile.switches).toContainEqual({ name: 'num-raster-threads', value: '8' })
  })

  it('maps the GPU budget and mode', () => {
    const low = deriveStartupProfile(settings({ gpuMemoryMb: 256, gpuMode: 'low' }))
    expect(low.switches).toEqual(
      expect.arrayContaining([
        { name: 'force-gpu-mem-available-mb', value: '256' },
        { name: 'force-gpu-mem-discardable-limit-mb', value: '128' },
        { name: 'disable-gpu-rasterization' },
        { name: 'disable-accelerated-video-decode' },
        { name: 'disable-accelerated-2d-canvas' }
      ])
    )
    expect(low.hardwareAcceleration).toBe(true)
    expect(deriveStartupProfile(settings({ gpuMode: 'off' })).hardwareAcceleration).toBe(false)
    expect(names(settings({ gpuMode: 'auto' }))).not.toContain('disable-gpu-rasterization')
  })

  it('detects when a relaunch is needed, ignoring switch order', () => {
    const a = deriveStartupProfile(settings())
    const b = deriveStartupProfile(
      settings({ process: { ...DEFAULT_RESOURCE_SETTINGS.process, rendererHeapMb: 256 } })
    )
    expect(profilesDiffer(a, deriveStartupProfile(settings()))).toBe(false)
    expect(profilesDiffer(a, b)).toBe(true)
    const reversed = { ...a, switches: [...a.switches].reverse() }
    expect(serializeProfile(reversed)).toBe(serializeProfile(a))
  })
})

describe('sanitizeResourceSettings', () => {
  it('returns the defaults for garbage input', () => {
    expect(sanitizeResourceSettings(undefined)).toEqual(DEFAULT_RESOURCE_SETTINGS)
    expect(sanitizeResourceSettings('nope')).toEqual(DEFAULT_RESOURCE_SETTINGS)
    expect(sanitizeResourceSettings({ process: 42 })).toEqual(DEFAULT_RESOURCE_SETTINGS)
  })

  it('keeps valid values, fills missing ones and clamps the rest', () => {
    const s = sanitizeResourceSettings({
      enforcement: 'extreme',
      memoryMb: '2048',
      memoryPercent: 1,
      cpuPercent: 250,
      batteryFactor: 0.1,
      maxConcurrentLoads: 0,
      gpuMode: 'sideways',
      protectAudible: 'yes',
      process: { rendererHeapMb: -5, lowEndDeviceMode: true }
    })
    expect(s.enforcement).toBe('extreme')
    expect(s.memoryMb).toBe(2048)
    expect(s.memoryPercent).toBe(5)
    expect(s.cpuPercent).toBe(100)
    expect(s.batteryFactor).toBe(0.25)
    expect(s.maxConcurrentLoads).toBe(1)
    expect(s.gpuMode).toBe('auto')
    expect(s.protectAudible).toBe(true)
    expect(s.process.rendererHeapMb).toBe(0)
    expect(s.process.lowEndDeviceMode).toBe(true)
    expect(s.process.disablePrerender).toBe(DEFAULT_RESOURCE_SETTINGS.process.disablePrerender)
  })
})

describe('automation switches', () => {
  /**
   * Chromium turns `navigator.webdriver` on for `--enable-automation`, `--headless` and
   * `--remote-debugging-*`, and Google's sign-in refuses such a browser as "not secure". No
   * resource profile may put any of them on the command line.
   */
  const AUTOMATION = new Set([
    'enable-automation',
    'headless',
    'remote-debugging-port',
    'remote-debugging-pipe',
    'remote-allow-origins',
    'test-type',
    'enable-blink-features'
  ])

  it('are never derived, whatever the resource settings', () => {
    const extremes: Array<Partial<ResourceSettings>> = [
      {},
      { enabled: false },
      {
        enforcement: 'extreme',
        gpuMode: 'off',
        process: {
          rendererProcessLimit: 1,
          rendererHeapMb: 256,
          lowEndDeviceMode: true,
          disableSpareRenderer: true,
          disableBackForwardCache: true,
          disablePrerender: true,
          rasterThreads: 1,
          v8OptimizeForSize: true
        }
      }
    ]
    for (const overrides of extremes) {
      const profile = deriveStartupProfile(settings(overrides))
      for (const sw of profile.switches) {
        expect(AUTOMATION.has(sw.name), sw.name).toBe(false)
        if (sw.name === 'disable-features' || sw.name === 'js-flags')
          expect(sw.value ?? '').not.toMatch(/AutomationControlled|webdriver/i)
      }
    }
  })
})

describe('startupSwitches', () => {
  it('switches FedCM off whatever the resource settings: Electron cannot serve its dialogs', () => {
    expect(BASELINE_DISABLED_FEATURES).toContain('FedCm')
    const off = startupSwitches(deriveStartupProfile(settings({ enabled: false })))
    expect(off).toEqual([{ name: 'disable-features', value: 'FedCm' }])
  })

  it('merges the baseline into the profile’s one disable-features switch, once', () => {
    const profile = deriveStartupProfile(settings())
    const own = profile.switches.find((sw) => sw.name === 'disable-features')
    expect(own?.value).toBe('SpareRendererForSitePerProcess,BackForwardCache,Prerender2')
    const applied = startupSwitches(profile)
    const disable = applied.filter((sw) => sw.name === 'disable-features')
    expect(disable).toHaveLength(1)
    expect(disable[0].value).toBe(
      'SpareRendererForSitePerProcess,BackForwardCache,Prerender2,FedCm'
    )
    // Everything else passes through in order, and the profile itself is untouched.
    expect(applied.filter((sw) => sw.name !== 'disable-features')).toEqual(
      profile.switches.filter((sw) => sw.name !== 'disable-features')
    )
    expect(profile.switches.find((sw) => sw.name === 'disable-features')?.value).toBe(own?.value)
    expect(startupSwitches(profile, ['FedCm', 'BackForwardCache'])).toEqual(applied)
  })

  it('switches Chromium’s own MPRIS player off on Linux only, where Zenium exports its own', () => {
    expect(baselineDisabledFeatures('linux')).toEqual(['FedCm', 'HardwareMediaKeyHandling'])
    expect(baselineDisabledFeatures('win32')).toEqual(['FedCm'])
    expect(baselineDisabledFeatures('darwin')).toEqual(['FedCm'])
    const linux = startupSwitches(
      deriveStartupProfile(settings({ enabled: false })),
      baselineDisabledFeatures('linux')
    )
    expect(linux).toEqual([{ name: 'disable-features', value: 'FedCm,HardwareMediaKeyHandling' }])
  })
})
