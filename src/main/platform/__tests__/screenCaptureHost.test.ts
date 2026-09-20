import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSources } = vi.hoisted(() => ({ getSources: vi.fn() }))
vi.mock('electron', () => ({
  desktopCapturer: { getSources },
  webContents: { fromFrame: () => undefined }
}))

import { ElectronScreenCapture } from '../screenCapture'
import type { ElectronTabViewHost } from '../views'
import type { ScreenCaptureService } from '../../../core/screenCapture'

/** A desktopCapturer source with an image whose emptiness and JPEG we control. */
function source(id: string, name: string, opts: { empty?: boolean } = {}): unknown {
  return {
    id,
    name,
    thumbnail: {
      isEmpty: () => opts.empty ?? false,
      toJPEG: () => Buffer.from(`jpeg:${id}`)
    },
    appIcon: { isEmpty: () => true, toDataURL: () => '' }
  }
}

function host(): ElectronScreenCapture {
  return new ElectronScreenCapture(
    {} as ElectronTabViewHost,
    (() => ({})) as unknown as () => ScreenCaptureService
  )
}

/** The `types` of each getSources call that carried options (a stricter, order-preserving view). */
function typeArgs(fn: typeof getSources): string[][] {
  return fn.mock.calls
    .map((call) => (call[0] as { types: string[] } | undefined)?.types)
    .filter((types): types is string[] => Array.isArray(types))
}

beforeEach(() => getSources.mockReset())

describe('ElectronScreenCapture.sources', () => {
  it('enumerates each type on its own so a failing window pass still returns the screens', async () => {
    getSources.mockImplementation(async (options?: { types: string[] }) => {
      if (options?.types[0] === 'window') throw new Error('no window manager')
      if (options?.types[0] === 'screen') return [source('screen:0:0', 'Entire Screen')]
      return []
    })
    const out = await host().sources(['screen', 'window'])
    // One getSources per type, each with only its own type (not both at once).
    expect(typeArgs(getSources)).toEqual([['screen'], ['window']])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'screen:0:0', kind: 'screen', name: 'Entire screen' })
    expect(out[0].thumbnail).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('names a lone screen "Entire screen" and numbers several; windows keep their names', async () => {
    getSources.mockImplementation(async (options?: { types: string[] }) => {
      if (options?.types[0] === 'screen')
        return [source('screen:0:0', 'Entire Screen'), source('screen:1:0', 'Screen 2')]
      return [source('window:12:0', 'Notes', { empty: true })]
    })
    const out = await host().sources(['screen', 'window'])
    // Chrome's own name is "Entire Screen"; Zenium lowercases the S to match its picker copy.
    expect(out.filter((s) => s.kind === 'screen').map((s) => s.name)).toEqual([
      'Entire screen',
      'Screen 2'
    ])
    const window = out.find((s) => s.kind === 'window')
    expect(window).toMatchObject({ id: 'window:12:0', name: 'Notes', thumbnail: null })
  })

  it('systemAudio is offered on Windows only', () => {
    const original = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      expect(host().systemAudio()).toBe(true)
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      expect(host().systemAudio()).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })
})
