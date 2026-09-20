// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DISPLAY_MODE_EVENT,
  FEATURE_MATCHES,
  FEATURE_MISMATCHES,
  displayModeFor,
  installDisplayModeShim,
  rewriteDisplayModeQuery
} from '../displayMode'

describe('displayModeFor', () => {
  const win = { chrome: 'full' as const, fullscreen: false, htmlFullscreenTabId: null }

  it('is browser in a browser window or popup, standalone in an app window', () => {
    expect(displayModeFor(win, 't1')).toBe('browser')
    expect(displayModeFor({ ...win, chrome: 'popup' }, 't1')).toBe('browser')
    expect(displayModeFor({ ...win, chrome: 'app' }, 't1')).toBe('standalone')
  })

  it('is fullscreen while the window is, or for the page in element fullscreen', () => {
    expect(displayModeFor({ ...win, fullscreen: true }, 't1')).toBe('fullscreen')
    expect(displayModeFor({ ...win, chrome: 'app', fullscreen: true }, 't1')).toBe('fullscreen')
    expect(displayModeFor({ ...win, htmlFullscreenTabId: 't1' }, 't1')).toBe('fullscreen')
    // Another page's element fullscreen is not this page's.
    expect(displayModeFor({ ...win, htmlFullscreenTabId: 't2' }, 't1')).toBe('browser')
  })
})

describe('rewriteDisplayModeQuery', () => {
  it('replaces each display-mode feature by an always-true or always-false one', () => {
    expect(rewriteDisplayModeQuery('(display-mode: standalone)', 'standalone')).toBe(
      FEATURE_MATCHES
    )
    expect(rewriteDisplayModeQuery('(display-mode: standalone)', 'browser')).toBe(
      FEATURE_MISMATCHES
    )
    expect(
      rewriteDisplayModeQuery(
        '(display-mode: standalone) and (min-width: 600px), (DISPLAY-MODE:fullscreen)',
        'fullscreen'
      )
    ).toBe(`${FEATURE_MISMATCHES} and (min-width: 600px), ${FEATURE_MATCHES}`)
  })

  it('leaves queries without the feature as they are', () => {
    expect(rewriteDisplayModeQuery('(min-width: 600px)', 'standalone')).toBe('(min-width: 600px)')
    expect(rewriteDisplayModeQuery('screen and (orientation: portrait)', 'browser')).toBe(
      'screen and (orientation: portrait)'
    )
  })
})

/** The engine's `matchMedia`: evaluates the rewritten markers (with a leading `not`) and can change. */
class FakeList extends EventTarget {
  matches: boolean
  readonly media: string
  constructor(query: string) {
    super()
    this.media = query
    const negated = query.startsWith('not ')
    const inner = !query.includes(FEATURE_MISMATCHES)
    this.matches = negated ? !inner : inner
  }
}

describe('installDisplayModeShim', () => {
  const native = vi.fn((query: string) => new FakeList(query))
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    native.mockClear()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: native
    })
    if (typeof globalThis.MediaQueryListEvent !== 'function') {
      class MediaQueryListEvent extends Event {
        readonly matches: boolean
        readonly media: string
        constructor(type: string, init: { matches?: boolean; media?: string } = {}) {
          super(type)
          this.matches = init.matches ?? false
          this.media = init.media ?? ''
        }
      }
      Object.defineProperty(globalThis, 'MediaQueryListEvent', {
        configurable: true,
        value: MediaQueryListEvent
      })
    }
  })

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia
    })
  })

  const setMode = (mode: string): void => {
    document.dispatchEvent(new CustomEvent(DISPLAY_MODE_EVENT, { detail: mode }))
  }

  it('answers display-mode queries with the browser’s mode and keeps the query text', () => {
    installDisplayModeShim('standalone', DISPLAY_MODE_EVENT)
    const standalone = window.matchMedia('(display-mode: standalone)')
    expect(standalone.matches).toBe(true)
    expect(standalone.media).toBe('(display-mode: standalone)')
    expect(window.matchMedia('(display-mode: browser)').matches).toBe(false)
    expect(window.matchMedia('(display-mode: minimal-ui)').matches).toBe(false)
    expect(window.matchMedia('not (display-mode: standalone)').matches).toBe(false)
    // The engine saw the rewritten query, never the display-mode feature itself.
    expect(native).toHaveBeenCalledWith(FEATURE_MATCHES)
    expect(native.mock.calls.every(([q]) => !q.includes('display-mode'))).toBe(true)
  })

  it('hands queries without the feature to the engine untouched', () => {
    installDisplayModeShim('browser', DISPLAY_MODE_EVENT)
    const list = window.matchMedia('(min-width: 600px)')
    expect(list).toBeInstanceOf(FakeList)
    expect(native).toHaveBeenCalledWith('(min-width: 600px)')
  })

  it('re-evaluates on a mode change and fires change for the listeners', () => {
    installDisplayModeShim('browser', DISPLAY_MODE_EVENT)
    const list = window.matchMedia('(display-mode: fullscreen)')
    const silent = window.matchMedia('(display-mode: fullscreen)')
    expect(list.matches).toBe(false)
    const heard: Array<{ matches: boolean; media: string; via: string }> = []
    list.addEventListener('change', (e) => {
      const ev = e as MediaQueryListEvent
      heard.push({ matches: ev.matches, media: ev.media, via: 'addEventListener' })
    })
    list.addListener((ev) =>
      heard.push({ matches: ev.matches, media: ev.media, via: 'addListener' })
    )
    list.onchange = (ev) => heard.push({ matches: ev.matches, media: ev.media, via: 'onchange' })

    setMode('fullscreen')
    expect(list.matches).toBe(true)
    expect(heard.map((h) => h.via).sort()).toEqual(['addEventListener', 'addListener', 'onchange'])
    expect(heard.every((h) => h.matches && h.media === '(display-mode: fullscreen)')).toBe(true)
    // A list nobody listens to answers the new mode when read.
    expect(silent.matches).toBe(true)

    heard.length = 0
    setMode('fullscreen')
    expect(heard).toHaveLength(0)
    setMode('browser')
    expect(list.matches).toBe(false)
    expect(heard).toHaveLength(3)
    expect(heard.every((h) => !h.matches)).toBe(true)
  })

  it('forwards the engine’s own change (a viewport feature in the query)', () => {
    installDisplayModeShim('standalone', DISPLAY_MODE_EVENT)
    const list = window.matchMedia('(display-mode: standalone) and (min-width: 600px)')
    expect(list.matches).toBe(true)
    const heard: boolean[] = []
    list.addEventListener('change', (e) => heard.push((e as MediaQueryListEvent).matches))
    const inner = native.mock.results.at(-1)?.value as FakeList
    inner.matches = false
    inner.dispatchEvent(new Event('change'))
    expect(list.matches).toBe(false)
    expect(heard).toEqual([false])
  })
})
