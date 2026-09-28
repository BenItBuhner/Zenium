// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { DEFAULT_READER_PREFERENCES, type ReaderPreferences } from '@shared/reader'
import { READER_URL_PREFIX } from '@shared/url'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { viewportStore } from '@renderer/lib/formFactor'
import { FrameDialogHost } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'
import { ReaderPreferencesPanel, Rows } from '../ReaderPreferencesPanel'

/*
 * Reader View's text preferences ON THE PHONE (W6-D29, the #587 follow-up): `ReaderPreferencesPanel`
 * is one shared component – `TabDialogs` mounts it on every host, the phone shell included – and
 * its `Rows` are one composition for both platforms; the form factor picks the chassis alone.
 * So the phone's sheet carries every row the desktop's popover does, Chrome's Links and Images
 * toggles (reader-12; one-line switch rows, the label alone, as Chrome's Settings menu has
 * them) among them, and each row's press goes through `reader.setPreferences` to
 * the SAME saved, synced record (`ReaderPreferences.links` / `.images`, Chrome's
 * `read_anything.links_enabled` / `images_enabled`): a peer's toggle reaches this phone's reader
 * document, and the phone has its own way back. Rendered for real in happy-dom on the frame's
 * dialog host under the phone form factor, as `TabDialogs` mounts it; the desktop's pins
 * (`translateRows.test.tsx`) stand untouched beside this file.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TAB = 't1'

function stateOf(reader: Partial<ReaderPreferences> = {}): UIState {
  const tab = {
    id: TAB,
    spaceId: 'space',
    containerId: 'default',
    url: `${READER_URL_PREFIX}https://a.example/article`,
    title: 'Alpha',
    favicon: null,
    pinned: false,
    essential: false,
    loading: false,
    canGoBack: true,
    canGoForward: false
  } as unknown as Tab
  return {
    platform: 'android',
    capabilities: {
      windowControls: false,
      extensions: false,
      pageTabs: true,
      readAloud: false,
      translate: false
    },
    tabs: { [tab.id]: tab },
    spaces: [],
    activeSpaceId: 'space',
    folders: {},
    essentialTabIds: [],
    containers: [],
    settings: {
      ...DEFAULT_SETTINGS,
      reader: { ...DEFAULT_READER_PREFERENCES, ...reader }
    },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    translate: { available: false },
    boosts: [],
    extensions: [],
    bookmarks: [],
    recentlyClosed: []
  } as unknown as UIState
}

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
}

/** The panel as `TabDialogs` mounts it on a phone: on the frame's dialog host, the sheet chassis. */
function showPanel(state: UIState): void {
  render(
    <FrameDialogHost frame>
      <ReaderPreferencesPanel state={state} panel={{ tabId: TAB, anchor: null, bar: null }} />
    </FrameDialogHost>
  )
}

const phone = (): void =>
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone', coarse: true })
const desktop = (): void =>
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false })

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  uiStore.set({ readerPreferences: { tabId: TAB, anchor: null, bar: null } })
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  uiStore.set({ readerPreferences: null })
  desktop()
  vi.unstubAllGlobals()
  vi.mocked(run).mockClear()
})

/** The rows container's children in order: a hairline as '—', a row as its label. */
const outline = (el: ParentNode): string[] =>
  [...el.querySelector('[data-reader-prefs-rows]')!.children].map((child) =>
    child.getAttribute('aria-hidden') === 'true' && child.childElementCount === 0
      ? '—'
      : (child.querySelector('.truncate')?.textContent ?? '?')
  )

const row = (pref: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`.zen-sheet [data-reader-pref="${pref}"]`)!

/** What the panel asked the core to save: the `reader.setPreferences` patches, in order. */
const patches = (): unknown[] =>
  vi
    .mocked(run)
    .mock.calls.filter(([name]) => name === 'reader.setPreferences')
    .map(([, args]) => args)

describe('the phone’s reader preferences', () => {
  it('open on the frame’s dialog host as the shared bottom sheet – the 48 header titled Text preferences, the rows under it – not the desktop popover', () => {
    phone()
    showPanel(stateOf())
    const sheet = document.querySelector<HTMLElement>(
      '.zen-frame-dialogs .zen-sheet[role="dialog"]'
    )
    expect(sheet).not.toBeNull()
    const title = sheet!.querySelector<HTMLElement>('h2.zen-sheet-title')!
    expect(title.textContent).toBe('Text preferences')
    expect(sheet!.getAttribute('aria-labelledby')).toBe(title.id)
    expect(sheet!.querySelector('[data-reader-prefs-panel]')).not.toBeNull()
    expect(sheet!.querySelector('[data-reader-prefs-rows]')).not.toBeNull()
    // The desktop popover renders through the chrome layer; on the phone there is none.
    expect(document.querySelector('#zen-chrome-layer [data-reader-prefs-panel]')).toBeNull()
  })

  it('carry every row the desktop’s popover carries – one composition, the form factor choosing the chassis alone – Links and Images the last two behind their hairline', () => {
    phone()
    const state = stateOf()
    showPanel(state)
    const sheet = document.querySelector<HTMLElement>('.zen-frame-dialogs .zen-sheet')!
    const onPhone = outline(sheet)
    expect(onPhone.slice(-3)).toEqual(['—', 'Links', 'Images'])
    expect(onPhone).toEqual([
      'Text size',
      'Font',
      'Colour theme',
      'Column width',
      'Line spacing',
      'Letter spacing',
      '—',
      'Line focus',
      'Lines in focus',
      'Syllables',
      '—',
      'Links',
      'Images'
    ])
    // The desktop's rows, rendered bare, read the same outline.
    act(() => root?.unmount())
    host?.remove()
    desktop()
    render(
      <Rows
        prefs={state.settings.reader}
        onChange={() => undefined}
        onListen={null}
        translate={null}
      />
    )
    expect(outline(host!)).toEqual(onPhone)
  })

  it('Links and Images are switch rows reading the saved record – a peer’s off shows off here – each press asking the core for the opposite of its own key alone (the synced keys)', () => {
    phone()
    showPanel(stateOf({ links: false }))
    const links = row('links')
    const images = row('images')
    expect(links.getAttribute('role')).toBe('switch')
    expect(images.getAttribute('role')).toBe('switch')
    expect(links.getAttribute('aria-checked')).toBe('false')
    expect(images.getAttribute('aria-checked')).toBe('true')
    // Chrome's words and Chrome's shape: the label alone, one line each, no description under
    // it (the desktop's pin reads the same shape; the phone's row is the desktop's).
    expect(links.querySelector('.truncate')?.textContent).toBe('Links')
    expect(images.querySelector('.truncate')?.textContent).toBe('Images')
    expect(links.querySelector('.line-clamp-2')).toBeNull()
    expect(images.querySelector('.line-clamp-2')).toBeNull()
    expect(patches()).toEqual([])
    act(() => links.click())
    act(() => images.click())
    expect(patches()).toEqual([{ links: true }, { images: false }])
  })

  it('a press on the phone goes where the desktop’s does: reader.setPreferences with the one key – the record is the core’s, not the sheet’s', () => {
    phone()
    showPanel(stateOf())
    act(() => row('images').click())
    expect(run).toHaveBeenCalledWith('reader.setPreferences', { images: false })
    act(() => row('links').click())
    expect(run).toHaveBeenCalledWith('reader.setPreferences', { links: false })
    // Nothing else was asked of the core by the presses.
    expect(patches()).toEqual([{ images: false }, { links: false }])
  })
})
