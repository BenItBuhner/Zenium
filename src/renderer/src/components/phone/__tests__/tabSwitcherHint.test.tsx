// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PhoneBarPosition, Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import type { BarHideHostFrame } from '@renderer/lib/barHide'
import type { Toast } from '@renderer/lib/ui'

/*
 * The tab switcher's in-product help (TB-19, useTabSwitcherHint.ts): Chrome 152's one default
 * toolbar bubble, on the rules `lib/iph.ts` restates. Driven in happy-dom with the phone bar's
 * Tabs button stood in: the deferred arm (two seconds, then an idle moment) before anything, the
 * record's one stamp, the bubble up when the moment is right and spent as it goes up – once per
 * session, once per device – and every way it comes down.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { run } = await import('@renderer/lib/api')
const { TAB_SWITCHER_ANCHOR, useTabSwitcherHint } = await import('../useTabSwitcherHint')
const {
  forgetHintBubble,
  HINT_BUBBLE_EXIT_MS,
  hintBubbleStore,
  IPH_ARM_DELAY_MS,
  iphSessionSpent,
  resetIphSession,
  spendIphSession,
  TAB_SWITCHER_HINT_ACCESSIBILITY_TEXT,
  TAB_SWITCHER_HINT_TEXT
} = await import('@renderer/lib/iph')
const {
  barHideStore,
  dispatchBarScroll,
  resetBarHide,
  setBarHideContext,
  setBarHideHost,
  setBarHideTouchExploration
} = await import('@renderer/lib/barHide')
const { browserStore, uiStore } = await import('@renderer/lib/ui')

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const ANCHOR = { x: 296, y: 860, width: 44, height: 44 }
const ANCHOR_RECT = { ...ANCHOR, left: ANCHOR.x, top: ANCHOR.y } as DOMRect
const TOAST: Toast = { id: 1, message: 'Back online', kind: 'info', duration: 5000 }

interface Knobs {
  onboardingDone?: boolean
  availableAt?: number | null
  shown?: boolean
  loading?: boolean
  privateTab?: boolean
  tabId?: string
}

function stateOf(k: Knobs = {}): UIState {
  const tabId = k.tabId ?? 't1'
  const tab = {
    id: tabId,
    url: 'https://example.com/',
    title: 'Example',
    loading: k.loading ?? false,
    containerId: k.privateTab ? PRIVATE_CONTAINER_ID : 'default'
  } as unknown as Tab
  return {
    activeSpaceId: 's1',
    spaces: [{ id: 's1', activeTabId: tabId, containerId: 'default' }],
    tabs: { [tabId]: tab },
    essentialTabIds: [],
    settings: {
      onboardingDone: k.onboardingDone ?? true,
      iph: {
        tabSwitcher: {
          availableAt: k.availableAt === undefined ? NOW - 15 * DAY : k.availableAt,
          shown: k.shown ?? false
        }
      }
    }
  } as unknown as UIState
}

function Hint({
  state,
  edge = 'bottom',
  calm = true
}: {
  state: UIState
  edge?: PhoneBarPosition
  calm?: boolean
}): null {
  useTabSwitcherHint(state, edge, calm)
  return null
}

let root: Root | null = null
let host: HTMLDivElement | null = null
let bar: HTMLElement | null = null
let idle: Array<() => void> = []

const render = (state: UIState, edge?: PhoneBarPosition, calm?: boolean): void => {
  act(() => root!.render(createElement(Hint, { state, edge, calm })))
}
const wait = (ms: number): void => {
  act(() => vi.advanceTimersByTime(ms))
}
/** The arm's two seconds, then its idle moment. */
const arm = (): void => {
  wait(IPH_ARM_DELAY_MS)
  const due = idle
  idle = []
  act(() => due.forEach((cb) => cb()))
}
const bubble = (): ReturnType<typeof hintBubbleStore.get> => hintBubbleStore.get()
const updates = (): unknown[] =>
  vi
    .mocked(run)
    .mock.calls.filter((c) => c[0] === 'settings.update')
    .map((c) => c[1])

/** The live bar's Tabs button, where the bubble looks for its anchor. */
function standBar(withTabs = true): void {
  bar?.remove()
  bar = document.createElement('nav')
  bar.className = 'zen-phone-bar'
  if (withTabs) {
    const button = document.createElement('button')
    button.dataset.barItem = 'tabs'
    button.getBoundingClientRect = () => ANCHOR_RECT
    bar.appendChild(button)
  }
  document.body.appendChild(bar)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.mocked(run).mockClear()
  idle = []
  vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
    idle.push(cb)
    return idle.length
  })
  vi.stubGlobal('cancelIdleCallback', () => undefined)
  resetIphSession()
  forgetHintBubble()
  setBarHideTouchExploration(false)
  uiStore.set({
    toasts: [],
    banners: [],
    screenshotCards: [],
    barHidden: false,
    insets: { top: 0, right: 0, bottom: 0, left: 0 }
  })
  standBar()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  bar?.remove()
  bar = null
  forgetHintBubble()
  resetIphSession()
  setBarHideTouchExploration(false)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the arm', () => {
  it('shows nothing and writes nothing inside the first two seconds, then stamps and shows', () => {
    render(stateOf({ availableAt: null }))
    wait(IPH_ARM_DELAY_MS - 1)
    expect(bubble().bubble).toBeNull()
    expect(run).not.toHaveBeenCalled()
    wait(1)
    // The two seconds are up; the arm still waits for an idle moment.
    expect(run).not.toHaveBeenCalled()
    act(() => idle.forEach((cb) => cb()))
    // Stamped at the arm, two seconds after the first paint: not due for 14 days.
    expect(updates()).toEqual([
      { iph: { tabSwitcher: { availableAt: NOW + IPH_ARM_DELAY_MS, shown: false } } }
    ])
    expect(bubble().bubble).toBeNull()
  })

  it('stamps once even while the core has not echoed the record yet', () => {
    const state = stateOf({ availableAt: null })
    render(state)
    arm()
    render({ ...state })
    render(stateOf({ availableAt: null, loading: true }))
    expect(updates()).toHaveLength(1)
  })
})

describe('the bubble goes up', () => {
  it('after the arm, on a loaded page under a calm chrome, 14 days in – once, spent as it goes', () => {
    render(stateOf())
    expect(bubble().bubble).toBeNull()
    arm()
    const up = bubble().bubble!
    expect(up).toMatchObject({
      id: 'tabSwitcher',
      anchorItem: 'tabs',
      anchor: ANCHOR,
      edge: 'bottom',
      text: TAB_SWITCHER_HINT_TEXT
    })
    expect(iphSessionSpent()).toBe(true)
    expect(updates()).toEqual([
      { iph: { tabSwitcher: { availableAt: NOW - 15 * DAY, shown: true } } }
    ])
    // The anchor is the live bar's button: never the carry's inert preview.
    expect(document.querySelector(TAB_SWITCHER_ANCHOR)).toBe(bar!.firstElementChild)
    // A chrome busy and calm again before the core's echo arms no second showing.
    forgetHintBubble()
    render(stateOf(), 'bottom', false)
    render(stateOf(), 'bottom', true)
    expect(bubble().bubble).toBeNull()
    expect(updates()).toHaveLength(1)
  })

  it('waits for the moment: a page still loading, a busy chrome, the bar hidden or a card up', () => {
    render(stateOf({ loading: true }))
    arm()
    expect(bubble().bubble).toBeNull()
    render(stateOf(), 'bottom', false)
    expect(bubble().bubble).toBeNull()
    act(() => uiStore.set({ barHidden: true }))
    render(stateOf())
    expect(bubble().bubble).toBeNull()
    act(() => uiStore.set({ barHidden: false, toasts: [TOAST] }))
    render(stateOf())
    expect(bubble().bubble).toBeNull()
    act(() => uiStore.set({ toasts: [] }))
    expect(bubble().bubble).not.toBeNull()
  })

  it('never in a private tab, before the first run is over, on a spent record or a spent session', () => {
    render(stateOf({ privateTab: true }))
    arm()
    expect(bubble().bubble).toBeNull()
    render(stateOf({ onboardingDone: false }))
    expect(bubble().bubble).toBeNull()
    render(stateOf({ shown: true }))
    expect(bubble().bubble).toBeNull()
    spendIphSession()
    render(stateOf())
    expect(bubble().bubble).toBeNull()
    expect(updates()).toHaveLength(0)
  })

  it('inside the 14 days it stays owed, and it stays owed while the bar has no Tabs button', () => {
    render(stateOf({ availableAt: NOW - 13 * DAY }))
    arm()
    expect(bubble().bubble).toBeNull()
    standBar(false)
    render(stateOf())
    expect(bubble().bubble).toBeNull()
    expect(iphSessionSpent()).toBe(false)
    standBar()
    render(stateOf({ tabId: 't2' }))
    expect(bubble().bubble).not.toBeNull()
  })

  it("says Chrome's longer sentence while an accessibility service explores by touch", () => {
    setBarHideTouchExploration(true)
    render(stateOf())
    arm()
    expect(bubble().bubble?.text).toBe(TAB_SWITCHER_HINT_ACCESSIBILITY_TEXT)
  })

  it('sits at the top edge for a top-docked bar', () => {
    render(stateOf(), 'top')
    arm()
    expect(bubble().bubble?.edge).toBe('top')
  })
})

describe('the bubble comes down', () => {
  const up = (): void => {
    render(stateOf())
    arm()
    expect(bubble()).toMatchObject({ leaving: false })
    expect(bubble().bubble).not.toBeNull()
  }
  const leaving = (): boolean => bubble().leaving

  it('on a touch anywhere on the chrome, heard in the capture phase and not swallowed: the touched control still runs', () => {
    up()
    // The finger lands on the Tabs button itself – Chrome's popup hears the touch and passes it
    // on, so the one tap takes the bubble down and opens the switcher. The stood-in button's
    // own handler stands for the control's: it must run, on an event nothing has cancelled,
    // after the bubble has already heard the touch in the capture phase.
    const button = bar!.querySelector<HTMLButtonElement>("[data-bar-item='tabs']")!
    const pressed = vi.fn((e: Event) => ({
      swallowed: e.defaultPrevented,
      bubbleLeaving: leaving()
    }))
    button.addEventListener('pointerdown', pressed)
    act(() => {
      button.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    })
    expect(leaving()).toBe(true)
    expect(pressed).toHaveBeenCalledTimes(1)
    expect(pressed).toHaveReturnedWith({ swallowed: false, bubbleLeaving: true })
    wait(HINT_BUBBLE_EXIT_MS)
    expect(bubble()).toEqual({ bubble: null, leaving: false })
    button.removeEventListener('pointerdown', pressed)
  })

  it("on the host's word of a finger landing on the page", () => {
    up()
    act(() => dispatchBarScroll('t1', 'start', null))
    expect(leaving()).toBe(true)
  })

  it("on the host's word with hide-on-scroll off – the down alone, and the bar's machine unmoved", () => {
    // TB-19's (f) clause. With the setting off the gate is closed: the chrome's word to the host
    // is `null` (`{ enabled: false }` on the bridge, `src/android/boot.ts`; no frame for
    // `BarHideGesture`), and the host reports a finger's down all the same
    // (`BarHideGesture.reports`, pinned by `BarHideGestureTest`). The bubble hears it, as
    // Chrome's hears the `ACTION_OUTSIDE` of a page touch whatever its toolbar does; the machine,
    // its gate closed, does not stir, and nothing more is said to the host.
    const hostFrames: Array<BarHideHostFrame | null> = []
    const settingIs = (hideToolbarOnScroll: boolean): void => {
      // The hook's state, filled out to what the stores' other listeners read of a browser state.
      const state = stateOf()
      browserStore.set({
        state: {
          ...state,
          platform: 'android',
          folders: [],
          spaces: state.spaces.map((s) => ({ ...s, tabIds: ['t1'] })),
          settings: { ...state.settings, hideToolbarOnScroll },
          window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null }
        } as unknown as UIState
      })
      setBarHideContext({ edge: 'bottom', present: true, band: 56, gutter: 8 })
    }
    try {
      settingIs(false)
      setBarHideHost({ apply: (frame) => hostFrames.push(frame) })
      expect(hostFrames).toEqual([null])
      expect(barHideStore.get()).toMatchObject({ allowed: false, phase: 'rest', progress: 0 })
      up()
      act(() => dispatchBarScroll('t1', 'start', null))
      expect(leaving()).toBe(true)
      expect(barHideStore.get()).toMatchObject({ allowed: false, phase: 'rest', progress: 0 })
      expect(hostFrames).toEqual([null])
      wait(HINT_BUBBLE_EXIT_MS)
      expect(bubble()).toEqual({ bubble: null, leaving: false })

      // The setting on: the same word takes the bubble down and sets the bar's drag going, as before.
      forgetHintBubble()
      resetIphSession()
      act(() => root!.unmount())
      root = createRoot(host!)
      settingIs(true)
      expect(barHideStore.get()).toMatchObject({ allowed: true, phase: 'rest', progress: 0 })
      expect(hostFrames.at(-1)).toMatchObject({ edge: 'bottom', offset: 0 })
      up()
      act(() => dispatchBarScroll('t1', 'start', null))
      expect(leaving()).toBe(true)
      expect(barHideStore.get()).toMatchObject({ allowed: true, phase: 'dragging' })
    } finally {
      resetBarHide()
      setBarHideContext({ present: false })
      setBarHideHost(null)
      browserStore.set({ state: null })
    }
  })

  it('when the chrome gets busy, the page navigates or another tab comes in front', () => {
    up()
    render(stateOf(), 'bottom', false)
    expect(leaving()).toBe(true)
    forgetHintBubble()
    resetIphSession()
    act(() => root!.unmount())
    root = createRoot(host!)
    up()
    render(stateOf({ loading: true }))
    expect(leaving()).toBe(true)
    forgetHintBubble()
    resetIphSession()
    act(() => root!.unmount())
    root = createRoot(host!)
    up()
    render(stateOf({ tabId: 't2' }))
    expect(leaving()).toBe(true)
  })

  it('when the screen changes under it – the insets, a resize – or the bar hides or a card arrives', () => {
    up()
    act(() => uiStore.set({ insets: { top: 0, right: 0, bottom: 300, left: 0 } }))
    expect(leaving()).toBe(true)
    forgetHintBubble()
    resetIphSession()
    act(() => root!.unmount())
    root = createRoot(host!)
    up()
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(leaving()).toBe(true)
    forgetHintBubble()
    resetIphSession()
    act(() => root!.unmount())
    root = createRoot(host!)
    up()
    act(() => uiStore.set({ toasts: [TOAST] }))
    expect(leaving()).toBe(true)
  })

  it('with the shell, outright', () => {
    up()
    act(() => root!.unmount())
    expect(bubble()).toEqual({ bubble: null, leaving: false })
  })
})
