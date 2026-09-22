import { describe, expect, it } from 'vitest'
import type { Platform } from '../../core/platform'
import type { Bridge } from '../bridge'
import { AndroidPlatform, type BootInfo } from '../platform'

const BOOT: BootInfo = {
  version: '0.0.0-test',
  sdkInt: 34,
  signer: null,
  packageName: null,
  files: {},
  downloadsDir: '/sdcard/Download',
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  fullscreen: false
}

function fakeBridge(): {
  bridge: Bridge
  calls: Array<{ method: string; args: Record<string, unknown> | undefined }>
} {
  const calls: Array<{ method: string; args: Record<string, unknown> | undefined }> = []
  const bridge = {
    call: async (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args })
      return null
    },
    send: (method: string, args?: Record<string, unknown>) => {
      calls.push({ method, args })
    },
    callSync: () => undefined
  } as unknown as Bridge
  return { bridge, calls }
}

/**
 * Page fonts on the phone (CT-25): the core's `Settings.fonts` document goes to Kotlin as one
 * `fonts.apply`, which maps it onto every page WebView's `WebSettings` (`PageFonts.kt`).
 */
describe('AndroidPlatform.pageFonts', () => {
  it('sends the fonts document to Kotlin as it is, field by field', () => {
    const { bridge, calls } = fakeBridge()
    const platform = new AndroidPlatform(bridge, BOOT)
    platform.pageFonts.apply({
      standard: 'sans-serif',
      serif: null,
      sansSerif: 'casual',
      fixed: null,
      size: 18,
      minimumSize: 8
    })
    expect(calls.filter((c) => c.method === 'fonts.apply')).toEqual([
      {
        method: 'fonts.apply',
        args: { standard: 'sans-serif', serif: null, sansSerif: 'casual', fixed: null, size: 18, minimumSize: 8 }
      }
    ])
  })

  it('has no languages host: WebView sends the system languages (the recorded CT-41 limit)', () => {
    const platform: Platform = new AndroidPlatform(fakeBridge().bridge, BOOT)
    expect(platform.languages).toBeUndefined()
    expect(platform.capabilities.pageLanguages).toBe(false)
    // The OS's languages still seed a fresh profile's list, read off the chrome document.
    expect(Array.isArray(platform.info.locales)).toBe(true)
  })
})
