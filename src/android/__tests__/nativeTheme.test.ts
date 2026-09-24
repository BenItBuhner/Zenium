// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ColorScheme, Space, SpaceTheme, UIState } from '@shared/types'
import { resolveTheme, rgbToHex } from '@shared/theme'
import { THEME_PAINTED_EVENT, type ThemePaintedDetail } from '@renderer/hooks/useTheme'
import { syncNativeTheme, type NativeTheme } from '../nativeTheme'

/*
 * The host's theme (`chrome.setTheme`) is read back from the document – a forced style
 * recalculation of the chrome – on a change of the theme and on nothing else (#349: the read ran
 * on every state event, 13 ms of the overview fold's first frame on thirty tabs). N state events
 * that leave the theme as it is cost one `getComputedStyle` and one hand-over; a change of the
 * theme – the setting, the chrome's own paint, the OS's scheme – costs one more of each; a read
 * that computes the theme already handed over sends nothing. The frame loop is cranked by hand.
 */

const frames: Array<() => void> = []
let sent: NativeTheme[] = []
let stateListener: ((state: UIState) => void) | null = null
let current: UIState
let systemDark = false
let systemDarkListeners: Array<() => void> = []
let computed: Mock<(element: Element) => CSSStyleDeclaration>
let uninstall: (() => void) | null = null

/** The tokens as the stub computes them: the polarity on the root decides, as `main.css` does. */
const TOKENS = {
  light: {
    color: 'rgba(0, 0, 0, 0.4)',
    backgroundColor: 'rgb(39, 40, 88)',
    borderTopColor: 'rgb(255, 255, 255)'
  },
  dark: {
    color: 'rgba(0, 0, 0, 0.6)',
    backgroundColor: 'rgb(169, 169, 244)',
    borderTopColor: 'rgb(21, 20, 26)'
  }
}
const HEX = {
  light: { scrim: '#00000066', accent: '#272858ff', onAccent: '#ffffffff' },
  dark: { scrim: '#00000099', accent: '#a9a9f4ff', onAccent: '#15141aff' }
}

const frame = (): void => {
  for (const cb of frames.splice(0)) cb()
}

function stateWith(
  colorScheme: ColorScheme,
  theme: SpaceTheme | null = null,
  unrelated = 0
): UIState {
  const space: Space = {
    id: 's1',
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme,
    tabIds: [],
    activeTabId: null,
    pinnedCollapsed: false
  }
  return {
    spaces: [space],
    activeSpaceId: 's1',
    // Something that changes from one commit to the next without touching the theme.
    tabs: Object.fromEntries(
      Array.from({ length: unrelated }, (_, i) => [`t${i}`, { id: `t${i}` }])
    ),
    settings: { colorScheme }
  } as unknown as UIState
}

/** The state event, as the core's `state` emitter delivers it. */
const commit = (state: UIState): void => {
  current = state
  stateListener?.(state)
}

const paint = (dark: boolean, background: string): void => {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  const detail: ThemePaintedDetail = { dark, background }
  window.dispatchEvent(new CustomEvent(THEME_PAINTED_EVENT, { detail }))
}

const background = (dark: boolean): string => rgbToHex(resolveTheme(null, dark).averageColor)

beforeEach(() => {
  frames.length = 0
  sent = []
  stateListener = null
  systemDark = false
  systemDarkListeners = []
  document.documentElement.dataset.theme = 'light'
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.splice(id - 1, 1)
  })
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return systemDark
    },
    addEventListener: (_type: string, listener: () => void) => {
      systemDarkListeners.push(listener)
    },
    removeEventListener: (_type: string, listener: () => void) => {
      systemDarkListeners = systemDarkListeners.filter((l) => l !== listener)
    }
  }))
  computed = vi.fn((element: Element) => {
    // The probe is in the document while it is read, and gone after (below).
    expect(element.parentElement).toBe(document.documentElement)
    const polarity = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
    return TOKENS[polarity] as unknown as CSSStyleDeclaration
  })
  vi.stubGlobal('getComputedStyle', computed)
  current = stateWith('light')
  uninstall = syncNativeTheme({
    bridge: {
      send: (method: string, args?: unknown) => {
        expect(method).toBe('chrome.setTheme')
        sent.push(args as NativeTheme)
      }
    },
    onState: (listener) => {
      stateListener = listener
      return () => {
        stateListener = null
      }
    },
    state: () => current
  })
})

afterEach(() => {
  uninstall?.()
  uninstall = null
  expect(stateListener).toBeNull()
  expect(systemDarkListeners).toEqual([])
  vi.unstubAllGlobals()
  expect(document.documentElement.querySelector('span')).toBeNull()
})

describe('the native theme is read on a change of the theme and on nothing else', () => {
  it('costs one read and one hand-over for N state events that leave the theme', () => {
    for (let i = 1; i <= 25; i++) {
      commit(stateWith('light', null, i))
      frame()
    }
    expect(computed).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([
      {
        dark: false,
        scheme: 'light',
        background: background(false),
        ...HEX.light
      }
    ])
  })

  it('reads a frame after the state event, once React has written the variables', () => {
    commit(stateWith('light'))
    expect(computed).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    frame()
    expect(computed).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
  })

  it('a change of the setting is one more read and one more hand-over', () => {
    commit(stateWith('light'))
    frame()
    // The chrome repaints on the setting (`useTheme`); the root's polarity follows.
    document.documentElement.dataset.theme = 'dark'
    commit(stateWith('dark', null, 3))
    frame()
    for (let i = 4; i <= 12; i++) {
      commit(stateWith('dark', null, i))
      frame()
    }
    expect(computed).toHaveBeenCalledTimes(2)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({
      dark: true,
      scheme: 'dark',
      background: background(true),
      ...HEX.dark
    })
  })

  it('a change of the active space’s theme is a change of the theme', () => {
    commit(stateWith('light'))
    frame()
    const theme: SpaceTheme = {
      type: 'gradient',
      colors: [{ c: [200, 40, 40], x: 0.5, y: 0.5, isPrimary: true }],
      opacity: 0.8,
      texture: 0,
      algorithm: 'floating',
      monochrome: false,
      rotation: 45
    }
    commit(stateWith('light', theme))
    frame()
    expect(computed).toHaveBeenCalledTimes(2)
    expect(sent).toHaveLength(2)
    expect(sent[1].background).toBe(rgbToHex(resolveTheme(theme, false).averageColor))
    expect(sent[1].background).not.toBe(sent[0].background)
  })

  it('the chrome’s paint is read at once and hands the painted polarity over', () => {
    commit(stateWith('light'))
    frame()
    // The mount's paint (`useTheme` paints at once and announces the settle): the theme the
    // state gave, read again and not sent again.
    paint(false, background(false))
    expect(computed).toHaveBeenCalledTimes(2)
    expect(sent).toHaveLength(1)
    // Light -> Dark: the state changes a blend ahead of the colours (the read it schedules
    // finds the root still painted light, and the pages keep their scheme), then the paint
    // crosses at the blend's midpoint and the host hears of it in the same frame.
    commit(stateWith('dark', null, 1))
    frame()
    expect(computed).toHaveBeenCalledTimes(3)
    expect(sent).toHaveLength(1)
    paint(true, '#101010')
    expect(computed).toHaveBeenCalledTimes(4)
    expect(frames).toHaveLength(0)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({
      dark: true,
      scheme: 'dark',
      background: '#101010',
      ...HEX.dark
    })
  })

  it('a paint of the theme already handed over is read but not sent again (the settle)', () => {
    commit(stateWith('light'))
    frame()
    paint(false, background(false))
    paint(false, background(false))
    expect(computed).toHaveBeenCalledTimes(3)
    expect(sent).toHaveLength(1)
  })

  it('a paint cancels the read a state event scheduled for the next frame', () => {
    commit(stateWith('light'))
    frame()
    commit(stateWith('dark', null, 1))
    expect(frames).toHaveLength(1)
    paint(true, '#101010')
    expect(frames).toHaveLength(0)
    frame()
    expect(computed).toHaveBeenCalledTimes(2)
    expect(sent).toHaveLength(2)
  })

  it('the OS’s scheme flipping under `system` is one more read and one more hand-over', () => {
    commit(stateWith('system'))
    frame()
    expect(sent).toEqual([
      { dark: false, scheme: 'system', background: background(false), ...HEX.light }
    ])
    systemDark = true
    document.documentElement.dataset.theme = 'dark'
    for (const listener of systemDarkListeners) listener()
    frame()
    expect(computed).toHaveBeenCalledTimes(2)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({
      dark: true,
      scheme: 'system',
      background: background(true),
      ...HEX.dark
    })
  })
})
