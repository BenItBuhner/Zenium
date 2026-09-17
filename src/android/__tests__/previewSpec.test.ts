import { describe, expect, it } from 'vitest'
import { PREVIEW_OVERLAYS, parsePreviewSpec } from '../previewSpec'

describe('parsePreviewSpec', () => {
  it('opens a known overlay by name', () => {
    expect(parsePreviewSpec('overlay=history')).toEqual({ kind: 'overlay', overlay: 'history' })
    for (const overlay of PREVIEW_OVERLAYS) {
      expect(parsePreviewSpec(`overlay=${overlay}`)).toEqual({ kind: 'overlay', overlay })
    }
  })

  it('types into the find bar, decoding the text as a query string would', () => {
    expect(parsePreviewSpec('find=coffee')).toEqual({ kind: 'find', text: 'coffee' })
    expect(parsePreviewSpec('find=hot%20tea+please')).toEqual({
      kind: 'find',
      text: 'hot tea please'
    })
    expect(parsePreviewSpec('find=')).toEqual({ kind: 'find', text: '' })
  })

  it('prefers the overlay when both are given and ignores a leading hash', () => {
    expect(parsePreviewSpec('#overlay=downloads&find=x')).toEqual({
      kind: 'overlay',
      overlay: 'downloads'
    })
    expect(parsePreviewSpec('#find=x')).toEqual({ kind: 'find', text: 'x' })
  })

  it('treats idle, an unknown overlay and junk as idle', () => {
    expect(parsePreviewSpec('idle')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('overlay=kitchen-sink')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('nonsense&more=1')).toEqual({ kind: 'idle' })
  })
})
