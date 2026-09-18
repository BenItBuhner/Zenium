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

  it('lands on a Settings section when one is named', () => {
    expect(parsePreviewSpec('overlay=settings&section=accessibility')).toEqual({
      kind: 'overlay',
      overlay: 'settings',
      section: 'accessibility'
    })
    expect(parsePreviewSpec('overlay=settings&section=')).toEqual({
      kind: 'overlay',
      overlay: 'settings'
    })
  })

  it('opens the app menu, behind an overlay but ahead of the bars', () => {
    expect(parsePreviewSpec('menu=app')).toEqual({ kind: 'menu' })
    expect(parsePreviewSpec('menu=app&show=Desktop Site')).toEqual({
      kind: 'menu',
      show: 'Desktop Site'
    })
    expect(parsePreviewSpec('menu=app&find=x')).toEqual({ kind: 'menu' })
    expect(parsePreviewSpec('overlay=history&menu=app')).toEqual({
      kind: 'overlay',
      overlay: 'history'
    })
    expect(parsePreviewSpec('menu=context')).toEqual({ kind: 'idle' })
  })

  it('puts up messages and the load bar together', () => {
    expect(parsePreviewSpec('toast=Tab%20closed&action=Undo&banners=2&progress=0.6')).toEqual({
      kind: 'messages',
      toast: { message: 'Tab closed', action: 'Undo', error: false },
      banners: 2,
      progress: 0.6
    })
    expect(parsePreviewSpec('toast=Failed&kind=error')).toEqual({
      kind: 'messages',
      toast: { message: 'Failed', action: null, error: true },
      banners: 0,
      progress: null
    })
    // Counts and fractions are clamped; junk reads as none.
    expect(parsePreviewSpec('banners=9&progress=7')).toMatchObject({ banners: 3, progress: 1 })
    expect(parsePreviewSpec('banners=x&progress=y')).toMatchObject({ banners: 0, progress: null })
    // Find wins over the messages.
    expect(parsePreviewSpec('find=x&toast=y')).toEqual({ kind: 'find', text: 'x' })
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

  it("fails the active tab's load with a Chromium net:: code, naming the URL that failed", () => {
    expect(parsePreviewSpec('error=-105&url=http%3A%2F%2Fnonexistent.invalid%2F')).toEqual({
      kind: 'error',
      code: -105,
      url: 'http://nonexistent.invalid/'
    })
    expect(parsePreviewSpec('error=-102&url=http://localhost:1/')).toEqual({
      kind: 'error',
      code: -102,
      url: 'http://localhost:1/'
    })
    expect(parsePreviewSpec('error=-106')).toEqual({ kind: 'error', code: -106, url: null })
    expect(parsePreviewSpec('error=-1&url=')).toEqual({ kind: 'error', code: -1, url: null })
    expect(parsePreviewSpec('error=')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('error=dns')).toEqual({ kind: 'idle' })
    expect(parsePreviewSpec('error=-1.5')).toEqual({ kind: 'idle' })
    // A pull comes first.
    expect(parsePreviewSpec('pull=40&error=-105')).toEqual({
      kind: 'pull',
      progress: 0.4,
      released: false
    })
  })
})
