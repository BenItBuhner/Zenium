import { describe, expect, it } from 'vitest'
import { PREVIEW_OVERLAYS, PREVIEW_PULL_MAX, parsePreviewSpec } from '../previewSpec'

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

  it('scrolls a row of an overlay into view when asked', () => {
    expect(parsePreviewSpec('overlay=settings&show=Pull%20to%20refresh')).toEqual({
      kind: 'overlay',
      overlay: 'settings',
      show: 'Pull to refresh'
    })
    expect(parsePreviewSpec('overlay=settings&show=')).toEqual({
      kind: 'overlay',
      overlay: 'settings'
    })
  })

  it('holds a pull at a percentage of the threshold, or lets go past it', () => {
    expect(parsePreviewSpec('pull=40')).toEqual({ kind: 'pull', progress: 0.4, released: false })
    expect(parsePreviewSpec('pull=100')).toEqual({ kind: 'pull', progress: 1, released: false })
    expect(parsePreviewSpec('pull=refresh')).toEqual({
      kind: 'pull',
      progress: PREVIEW_PULL_MAX,
      released: true
    })
    // Clamped to what the page can show, and never negative.
    expect(parsePreviewSpec('pull=900')).toEqual({
      kind: 'pull',
      progress: PREVIEW_PULL_MAX,
      released: false
    })
    expect(parsePreviewSpec('pull=-5')).toEqual({ kind: 'pull', progress: 0, released: false })
    expect(parsePreviewSpec('pull=')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('pull=lots')).toEqual({ kind: 'idle' })
    // The find bar and overlays come first.
    expect(parsePreviewSpec('find=x&pull=40')).toEqual({ kind: 'find', text: 'x' })
  })
})
