// @vitest-environment happy-dom
import type { ExtensionBoot } from '@core/extensions/runtime/boot'
import { extensionUrl } from '@core/extensions/runtime/plan'
import { describe, expect, it } from 'vitest'
import { SHAPE_DETECTION_INTERFACES, withdrawShapeDetection } from '../extensionShapeDetection'

/*
 * The Shape Detection API on the phone's extension pages. Android WebView binds its detectors in
 * the app's process through the Google Play services client the provider carries, behind a check
 * of the APP's manifest for `com.google.android.gms.version`; on compat round 22's snapshot
 * WebView that check threw on `Chrome_InProcGpuThread`, uncaught into JNI, and the app died under
 * QR Code Reader's popup at `BarcodeDetector.getSupportedFormats()`. An extension page now boots
 * without the three constructors, so a page's feature check (`'BarcodeDetector' in window`) takes
 * the path it takes in a browser without the API; the worker page's realm is left as it is. One
 * boot per test file (the bootstrap is an IIFE over `__zenExtBoot`).
 */

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

const TOKEN = 'unit-test-token'
const EXT = 'q'.repeat(32)

/** A realm with the API's three constructors as WebIDL puts them on a global: configurable, writable, not enumerable. */
const realmWithDetectors = (): Record<string, unknown> => {
  const realm: Record<string, unknown> = {}
  for (const name of SHAPE_DETECTION_INTERFACES)
    Object.defineProperty(realm, name, {
      value: class {},
      writable: true,
      configurable: true,
      enumerable: false
    })
  return realm
}

describe('withdrawShapeDetection', () => {
  it('takes the three constructors off a realm that has them and names them, in order', () => {
    const realm = realmWithDetectors()
    expect(withdrawShapeDetection(realm)).toEqual([
      'BarcodeDetector',
      'FaceDetector',
      'TextDetector'
    ])
    for (const name of SHAPE_DETECTION_INTERFACES) expect(name in realm).toBe(false)
  })

  it('names only what the realm had: a WebView without the API contributes nothing, one with the barcode detector alone that one', () => {
    expect(withdrawShapeDetection({})).toEqual([])
    const realm: Record<string, unknown> = {}
    Object.defineProperty(realm, 'BarcodeDetector', { value: class {}, configurable: true })
    expect(withdrawShapeDetection(realm)).toEqual(['BarcodeDetector'])
    expect('BarcodeDetector' in realm).toBe(false)
  })

  it('leaves a constructor the realm refuses to part with, unlisted, and takes the others', () => {
    const realm = realmWithDetectors()
    Object.defineProperty(realm, 'FaceDetector', { value: class {}, configurable: false })
    expect(withdrawShapeDetection(realm)).toEqual(['BarcodeDetector', 'TextDetector'])
    expect('FaceDetector' in realm).toBe(true)
    expect('BarcodeDetector' in realm).toBe(false)
  })

  it('touches nothing else of the realm', () => {
    const realm = realmWithDetectors()
    realm.IntersectionObserver = class {}
    realm.BarcodeReader = class {}
    withdrawShapeDetection(realm)
    expect(realm.IntersectionObserver).toBeTypeOf('function')
    expect(realm.BarcodeReader).toBeTypeOf('function')
  })
})

describe('the page bootstrap and the Shape Detection API', () => {
  it('boots a popup without the constructors and says so in its debug stats', async () => {
    const posted: Array<Record<string, unknown>> = []
    const bridge: Bridge = {
      postMessage: (message) => {
        posted.push(JSON.parse(message) as Record<string, unknown>)
      },
      onmessage: null
    }
    const g = globalThis as typeof globalThis & {
      __zenExtBridge?: Bridge
      __zenExtBoot?: unknown
      __zenExtStats?: { page?: string; shapeDetection?: string[] }
      happyDOM?: { setURL(url: string): void }
      BarcodeDetector?: unknown
      FaceDetector?: unknown
      TextDetector?: unknown
    }
    // The popup's document on the origin the runtime serves it from, on a WebView with the API.
    g.happyDOM?.setURL(extensionUrl(EXT, 'popup.html'))
    for (const name of SHAPE_DETECTION_INTERFACES)
      Object.defineProperty(g, name, {
        value: class {
          static getSupportedFormats(): Promise<string[]> {
            return Promise.resolve(['qr_code'])
          }
        },
        writable: true,
        configurable: true,
        enumerable: false
      })
    expect('BarcodeDetector' in g).toBe(true)
    const ext: ExtensionBoot = {
      id: EXT,
      name: 'QR Code Reader',
      version: '1.0',
      manifestVersion: 3,
      permissions: ['storage'],
      optionalPermissions: [],
      hostPermissions: [],
      manifest: {
        manifest_version: 3,
        name: 'QR Code Reader',
        version: '1.0',
        action: { default_popup: 'popup.html' }
      },
      messages: null,
      groups: [],
      isolation: 'with'
    }
    g.__zenExtBridge = bridge
    g.__zenExtBoot = {
      config: { kind: 'page', token: TOKEN, uiLanguage: 'en', context: 'popup', extension: ext },
      sources: {},
      css: {},
      debug: true
    }
    await import('../extensionBootstrap')
    expect(posted.find((m) => m.t === 'hello')).toMatchObject({ ctx: 'popup', ext: EXT })
    // The page's feature check finds no API: the library's fallback path, not the bind.
    expect('BarcodeDetector' in g).toBe(false)
    expect('FaceDetector' in g).toBe(false)
    expect('TextDetector' in g).toBe(false)
    expect(g.__zenExtStats).toMatchObject({
      page: 'popup',
      shapeDetection: ['BarcodeDetector', 'FaceDetector', 'TextDetector']
    })
  })
})
