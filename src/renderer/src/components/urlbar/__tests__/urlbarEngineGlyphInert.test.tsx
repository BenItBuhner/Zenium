// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Fragment, act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Suggestion, Tab, UIState } from '@shared/types'
import type { UrlbarState } from '@renderer/lib/ui'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import { NEW_TAB_URL } from '@shared/url'

/*
 * The phone omnibox's engine mark stays inert (OMN-38, partial-by-design on the root's ruling of
 * 2026-09-26): in Chrome for Android 152 a tap on the default search engine's logo does nothing
 * (`StatusMediator.maybeUpdateStatusIconForSearchEngineIcon()` sets `STATUS_CLICK_LISTENER` to
 * null, tag 152.0.7977.89), and parity is the mandate. The one test here pins the slot as a
 * `role="img"` named for the engine – inside no button, with no handler, nothing up and nothing
 * asked of the host on a tap – so a control is not added there again without a ruling (the
 * picker #567 built as its Form A is kept on `cursor/android-omnibox-engine-glyph-form-a-9271`).
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'urlbar.suggest') return [] as Suggestion[]
  return null
})
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { Urlbar } = await import('../Urlbar')
const { uiStore } = await import('@renderer/lib/ui')
const { FrameDialogHost } = await import('@renderer/lib/portals')

const tab: Tab = {
  id: 't1',
  spaceId: 'space',
  containerId: 'default',
  url: NEW_TAB_URL,
  title: 'New tab',
  favicon: null,
  pinned: false,
  essential: false,
  pinnedUrl: null,
  customTitle: null,
  customIcon: null,
  windowId: null,
  folderId: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  audible: false,
  muted: false,
  discarded: false,
  frozen: false,
  cpuThrottle: 1,
  zoom: 1,
  splitGroupId: null,
  createdAt: 0,
  lastActiveAt: 0,
  errorCode: null,
  bookmarked: false,
  readerable: false,
  blockedCount: 0
} as Tab

const state = {
  platform: 'android',
  capabilities: {},
  tabs: { [tab.id]: tab },
  spaces: [],
  activeSpaceId: 'space',
  settings: { ...DEFAULT_SETTINGS, searchEngineId: 'google' },
  searchEngines: DEFAULT_SEARCH_ENGINES,
  window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null }
} as unknown as UIState

const urlbar: UrlbarState = {
  open: true,
  mode: 'new-tab',
  tabId: tab.id,
  initialText: undefined,
  attached: true
}

/** The phone omnibox over a new tab, the frame's dialog host after it: where a sheet would mount. */
const phone = (): ReactElement =>
  createElement(
    Fragment,
    null,
    createElement(Urlbar, { state, urlbar, area: null, phoneEdge: 'top' }),
    createElement(FrameDialogHost, { frame: true })
  )

let root: Root | null = null
let host: HTMLElement | null = null

const commands = (): string[] => invoke.mock.calls.map(([name]) => name)

beforeEach(() => {
  invoke.mockClear()
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

it('the engine mark at the phone field’s start is a role="img" named for the engine – inside no button, with no handler – and a tap on it opens nothing and asks nothing, as Chrome’s logo (OMN-38)', async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(phone())
  })
  await act(async () => {
    await vi.waitFor(() => expect(commands()).toContain('urlbar.suggest'))
  })
  const field = host.querySelector<HTMLElement>('.zen-omnibox-field')!
  const input = field.querySelector<HTMLInputElement>('[data-testid="urlbar-input"]')!
  const mark = field.querySelector<HTMLElement>('[data-testid="engine-field-glyph"]')!
  expect(mark).not.toBeNull()

  // The mark: an image named for the engine, the 28 slot the NTP-09 tests hold it to.
  expect(mark.tagName).toBe('SPAN')
  expect(mark.getAttribute('role')).toBe('img')
  expect(mark.getAttribute('aria-label')).toBe('Search engine: Google')
  expect(mark.className).toContain('h-7 w-7')

  // Not a control and inside none: no button, link or focusable wraps it; it carries no popup,
  // no expanded state, no tab stop. The mark is the field's first child, the input the second.
  expect(mark.closest('button, [role="button"], a, [role="link"], [tabindex]')).toBeNull()
  expect(mark.hasAttribute('aria-haspopup')).toBe(false)
  expect(mark.hasAttribute('aria-expanded')).toBe(false)
  expect(mark.hasAttribute('tabindex')).toBe(false)
  expect(field.children[0]).toBe(mark)
  expect(field.children[1]).toBe(input)
  // Every control in the field is a trailing one (Clear, the mic, the camera): none stands
  // before the input, none is named for the engine.
  for (const control of Array.from(field.querySelectorAll('button, [role="button"]'))) {
    expect(input.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(control.getAttribute('aria-label') ?? '').not.toMatch(/^Search engine/)
  }

  // No handler on the slot: React's props for the element carry no pointer, click or key handler.
  const propsKey = Object.keys(mark).find((k) => k.startsWith('__reactProps$'))
  expect(propsKey).toBeDefined()
  const props = (mark as unknown as Record<string, Record<string, unknown>>)[propsKey!]
  for (const handler of ['onClick', 'onPointerDown', 'onPointerUp', 'onTouchStart', 'onKeyDown']) {
    expect(props[handler], handler).toBeUndefined()
  }

  // A tap: nothing comes up on the frame's dialog host, nothing is asked of the host, the mark
  // and the field are as they were, the bar stays open with the focus on the field.
  input.focus()
  invoke.mockClear()
  await act(async () => {
    mark.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' })
    )
    mark.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch' })
    )
    mark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 120))
  })
  expect(document.querySelector('.zen-sheet[role="dialog"]')).toBeNull()
  expect(document.querySelector('[role="radiogroup"]')).toBeNull()
  expect(commands()).toEqual([])
  expect(mark.getAttribute('aria-label')).toBe('Search engine: Google')
  expect(input.placeholder).toBe('Search or enter address')
  expect(uiStore.get().urlbar.open).toBe(true)
  expect(document.activeElement).toBe(input)
})
