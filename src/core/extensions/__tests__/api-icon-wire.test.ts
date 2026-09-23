import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ICON_SLOT,
  captureIconWireEnv,
  compactIconDetails,
  compactImage,
  type IconImage,
  type IconWireCanvas,
  type IconWireContext2d,
  type IconWireEnv,
  type WireImage
} from '../api/iconWire'

/** RGBA bytes of a [size]×[size] image with a recognisable first pixel. */
function pixels(width: number, height = width, first = [10, 20, 30, 255]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < out.length; i += 4) {
    out[i] = first[0]
    out[i + 1] = first[1]
    out[i + 2] = first[2]
    out[i + 3] = first[3]
  }
  return out
}

const image = (width: number, height = width, first?: number[]): IconImage => ({
  width,
  height,
  data: pixels(width, height, first)
})

const decode = (wire: WireImage): Uint8ClampedArray =>
  new Uint8ClampedArray(Buffer.from(wire.data, 'base64'))

interface Drawn {
  source: { width: number; height: number; put: unknown }
  args: number[]
  smoothing: boolean
  quality: string | undefined
}

/**
 * A fake realm: canvases whose 2D context records what was drawn and answers `getImageData`
 * with the drawn source's first pixel over the requested size (a scaler that keeps colour).
 */
function fakeEnv(withCanvas = true): IconWireEnv & { drawn: Drawn[] } {
  const drawn: Drawn[] = []
  const canvas = (width: number, height: number): IconWireCanvas => {
    const own: Drawn['source'] & IconWireCanvas = {
      width,
      height,
      put: undefined,
      getContext: () => context
    }
    const context: IconWireContext2d = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: undefined,
      putImageData: (data) => {
        own.put = data
      },
      drawImage: (source, ...args) => {
        drawn.push({
          source: source as Drawn['source'],
          args,
          smoothing: context.imageSmoothingEnabled,
          quality: context.imageSmoothingQuality
        })
      },
      getImageData: (_sx, _sy, sw, sh) => {
        const last = drawn[drawn.length - 1]
        const put = (last?.source.put ?? null) as { data: Uint8ClampedArray } | null
        const first = put ? Array.from(put.data.subarray(0, 4)) : [0, 0, 0, 0]
        return { data: pixels(sw, sh, first) }
      }
    }
    return own
  }
  return {
    drawn,
    canvas: withCanvas ? canvas : () => null,
    imageData: (data, width, height) => ({ data, width, height }),
    btoa: (binary) => Buffer.from(binary, 'binary').toString('base64')
  }
}

describe('iconWire: setIcon pixels compacted for the text bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a 96 px icon is drawn down to the 32 slot with smoothing and crosses as 4 KB of base64', () => {
    const env = fakeEnv()
    const wire = compactImage(image(96), env)
    expect([wire.width, wire.height]).toEqual([ICON_SLOT, ICON_SLOT])
    const bytes = decode(wire)
    expect(bytes.length).toBe(32 * 32 * 4)
    expect(Array.from(bytes.subarray(0, 4))).toEqual([10, 20, 30, 255])
    expect(wire.data.length).toBe(5464)
    expect(env.drawn).toHaveLength(1)
    expect(env.drawn[0].args).toEqual([0, 0, 96, 96, 0, 0, 32, 32])
    expect(env.drawn[0].smoothing).toBe(true)
    expect(env.drawn[0].quality).toBe('high')
    expect(env.drawn[0].source).toMatchObject({ width: 96, height: 96 })
  })

  it('a non-square image keeps its aspect: the longer side becomes the slot', () => {
    const env = fakeEnv()
    const wire = compactImage(image(64, 32), env)
    expect([wire.width, wire.height]).toEqual([32, 16])
    expect(decode(wire).length).toBe(32 * 16 * 4)
    expect(env.drawn[0].args).toEqual([0, 0, 64, 32, 0, 0, 32, 16])
  })

  it('an image at or under the slot is not drawn at all, only encoded', () => {
    const env = fakeEnv()
    const small = image(16, 16, [1, 2, 3, 4])
    const wire = compactImage(small, env)
    expect([wire.width, wire.height]).toEqual([16, 16])
    expect(decode(wire)).toEqual(small.data)
    expect(env.drawn).toHaveLength(0)
  })

  it('without a drawing surface the bytes cross unscaled, still as base64 (a third the object form)', () => {
    const env = fakeEnv(false)
    const wire = compactImage(image(96), env)
    expect([wire.width, wire.height]).toEqual([96, 96])
    expect(wire.data.length).toBe(49152)
    expect(decode(wire)).toEqual(pixels(96))
    // The shim's form, member by member, for the same pixels.
    const asObject = JSON.stringify(image(96)).length
    expect(asObject).toBeGreaterThan(250_000)
    expect(JSON.stringify(wire).length).toBeLessThan(asObject / 5)
  })

  it('of a dictionary by size the smallest at least the slot is taken, else the largest', () => {
    const env = fakeEnv()
    const fits = compactIconDetails(
      {
        imageData: {
          '16': image(16, 16, [1, 1, 1, 1]),
          '48': image(48, 48, [4, 8, 4, 8]),
          '128': image(128)
        }
      },
      env
    ) as { imageData: WireImage }
    expect([fits.imageData.width, fits.imageData.height]).toEqual([32, 32])
    expect(Array.from(decode(fits.imageData).subarray(0, 4))).toEqual([4, 8, 4, 8])
    expect(env.drawn[0].args).toEqual([0, 0, 48, 48, 0, 0, 32, 32])

    const under = compactIconDetails(
      { imageData: { '16': image(16, 16, [1, 1, 1, 1]), '24': image(24, 24, [2, 4, 2, 4]) } },
      fakeEnv()
    ) as { imageData: WireImage }
    expect([under.imageData.width, under.imageData.height]).toEqual([24, 24])
    expect(Array.from(decode(under.imageData).subarray(0, 4))).toEqual([2, 4, 2, 4])
  })

  it('the rest of the details cross as they were, and details without usable pixels come back untouched', () => {
    const env = fakeEnv()
    const details = { imageData: image(96), tabId: 7 }
    const compact = compactIconDetails(details, env) as Record<string, unknown>
    expect(compact.tabId).toBe(7)
    expect(Object.keys(compact).sort()).toEqual(['imageData', 'tabId'])
    expect((compact.imageData as WireImage).width).toBe(32)
    // The caller's object is not written to.
    expect(details.imageData.width).toBe(96)
    expect(details.imageData.data).toBeInstanceOf(Uint8ClampedArray)

    const byPath = { path: 'https://x.ext.zenium.invalid/icon.png', tabId: 3 }
    expect(compactIconDetails(byPath, env)).toBe(byPath)
    const tooShort = { imageData: { width: 96, height: 96, data: new Uint8ClampedArray(16) } }
    expect(compactIconDetails(tooShort, env)).toBe(tooShort)
    const noImage = { imageData: { '32': 'not an image' } }
    expect(compactIconDetails(noImage, env)).toBe(noImage)
    expect(compactIconDetails(null, env)).toBeNull()
    expect(compactIconDetails('x', env)).toBe('x')
    expect(compactIconDetails({ imageData: null, tabId: 1 }, env)).toEqual({
      imageData: null,
      tabId: 1
    })
    expect(env.drawn).toHaveLength(1)
  })

  it("the bytes are read from a typed array, a view, a buffer or a plain array alike, longer ones cut to the image's size", () => {
    const env = fakeEnv(false)
    const reference = compactImage(image(8, 8, [9, 8, 7, 6]), env).data
    const raw = pixels(8, 8, [9, 8, 7, 6])
    const longer = new Uint8ClampedArray(8 * 8 * 4 + 12)
    longer.set(raw)
    const wired = (data: unknown): string =>
      (
        compactIconDetails({ imageData: { width: 8, height: 8, data } }, env) as {
          imageData: WireImage
        }
      ).imageData.data
    expect(wired(new Uint8Array(raw))).toBe(reference)
    expect(wired(raw.buffer)).toBe(reference)
    expect(wired(Array.from(raw))).toBe(reference)
    expect(wired(longer)).toBe(reference)
    expect(wired(new DataView(longer.buffer, 0, raw.length))).toBe(reference)
  })

  it("the realm's own surfaces are captured once, and base64 is right with or without btoa", () => {
    // Node: no OffscreenCanvas, no ImageData; btoa present.
    const own = captureIconWireEnv()
    expect(own.canvas(4, 4)).toBeNull()
    expect(own.imageData(new Uint8ClampedArray(64), 4, 4)).toBeNull()
    const wire = compactImage(image(96), own)
    expect([wire.width, wire.height]).toEqual([96, 96])
    expect(wire.data).toBe(Buffer.from(pixels(96)).toString('base64'))

    vi.stubGlobal('btoa', undefined)
    const without = captureIconWireEnv()
    for (const length of [1, 2, 3, 4, 5, 6, 4097]) {
      const bytes = new Uint8ClampedArray(length).map((_, i) => (i * 37 + 11) & 0xff)
      const binary = String.fromCharCode(...bytes)
      expect(without.btoa(binary)).toBe(Buffer.from(bytes).toString('base64'))
    }

    // A realm whose canvas constructor throws (a worker without the surface) still encodes.
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor() {
          throw new Error('no surface')
        }
      }
    )
    const throwing = captureIconWireEnv()
    expect(throwing.canvas(96, 96)).toBeNull()
    expect(compactImage(image(96), throwing).width).toBe(96)
  })

  it('a surface that fails mid-draw leaves the pixels as they were', () => {
    const env = fakeEnv()
    const broken: IconWireEnv = {
      ...env,
      canvas: (width, height) => {
        const canvas = env.canvas(width, height)
        if (!canvas) return null
        const context = canvas.getContext('2d')
        if (!context) return canvas
        return {
          getContext: () => ({
            ...context,
            drawImage: () => {
              throw new Error('lost context')
            }
          })
        }
      }
    }
    const wire = compactImage(image(96, 96, [5, 6, 7, 8]), broken)
    expect([wire.width, wire.height]).toEqual([96, 96])
    expect(Array.from(decode(wire).subarray(0, 4))).toEqual([5, 6, 7, 8])
  })
})
