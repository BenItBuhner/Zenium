// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_CONTAINER_ID, type Space, type Tab, type UIState } from '@shared/types'

const cmd = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
const run = vi.fn<(name: string, args?: unknown) => void>()
vi.mock('@renderer/lib/api', () => ({
  cmd: (name: string, args?: unknown) => cmd(name, args),
  run: (name: string, args?: unknown) => run(name, args),
  onEvent: vi.fn(() => () => undefined)
}))

import { announcerStore, resetAnnouncer } from '@renderer/lib/announce'
import { closeAllPopovers } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'
import { MEMORY_SAVER_DETAIL, MemorySaverBubble } from '../MemorySaverBubble'

/*
 * Chrome's Memory Saver bubble on the desktop (omnibox-40 / tabs-40): the 320 notice under the
 * pill's slot for a tab just woken from sleep – the title with the number the discard recorded,
 * the one sentence on why, and the Never unload this site row that puts the site's registrable
 * domain on the never-sleep list (`settings.unloadExcludedDomains`, the form Settings' Add
 * current site writes) and closes the bubble. No row in a private window or for a site already
 * on the list.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

const page: Tab = {
  id: 't1',
  url: 'https://mail.google.com/mail/u/0/#inbox',
  containerId: DEFAULT_CONTAINER_ID,
  title: 'Inbox',
  favicon: null,
  loading: false,
  blockedCount: 0,
  memorySaver: { savedMb: 312, wokeAt: Date.now() }
} as unknown as Tab

const space: Space = {
  id: 'space',
  name: 'Work',
  icon: '',
  containerId: DEFAULT_CONTAINER_ID,
  theme: null,
  tabIds: ['t1'],
  activeTabId: 't1',
  pinnedCollapsed: false
}

function state(patch: Partial<UIState> = {}, excluded: string[] = []): UIState {
  return {
    platform: 'linux',
    capabilities: {},
    tabs: { t1: page },
    spaces: [space],
    activeSpaceId: 'space',
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    settings: { unloadExcludedDomains: excluded },
    ...patch
  } as unknown as UIState
}

const bubble = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="memory-saver-bubble"]')

/** The chrome layer drew the popover and its first paint settled. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  cmd.mockClear()
  run.mockReset()
  resetAnnouncer()
  uiStore.set({ memorySaverBubble: { tabId: 't1' } })
})

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  uiStore.set({ memorySaverBubble: null })
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('the Memory Saver bubble (omnibox-40)', () => {
  it('is a 320 dialog under the slot: the leaf on the title, the number the discard recorded, the one sentence, and the Never unload row below a hairline', async () => {
    render(<MemorySaverBubble state={state()} bubble={{ tabId: 't1' }} />)
    await settle()
    const dialog = bubble()!
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-labelledby')).toBe('zen-memory-saver-title')
    expect(dialog.getAttribute('data-saved-mb')).toBe('312')
    // §9.20's list width: the popover's own width variable is the 320 of the three.
    expect(dialog.style.width).toBe('320px')
    const title = dialog.querySelector<HTMLElement>('#zen-memory-saver-title')!
    expect(title.tagName).toBe('H2')
    expect(title.textContent).toBe('Memory Saver freed up 312 MB')
    // The leaf leads the title block (§9.23); the sentence under it in the deemphasised ink.
    expect(dialog.querySelector('svg.lucide-leaf')).not.toBeNull()
    const sentence = dialog.querySelector<HTMLElement>('p')!
    expect(sentence.textContent).toBe(MEMORY_SAVER_DETAIL)
    expect(MEMORY_SAVER_DETAIL).toBe('This tab was inactive, so Zenium unloaded it to free memory.')
    // The row: a button in the tab order, named for the site's registrable domain – the form
    // the never-sleep list keeps – below the hairline.
    const row = dialog.querySelector<HTMLElement>('[data-never-unload]')!
    expect(row.tagName).toBe('BUTTON')
    expect(row.tabIndex).toBe(0)
    expect(row.textContent).toBe('Never unload this site')
    expect(row.getAttribute('aria-label')).toBe('Never unload google.com')
    expect(row.getAttribute('data-never-unload')).toBe('google.com')
    expect(row.classList.contains('zen-v2-row')).toBe(true)
    expect(row.previousElementSibling?.classList.contains('h-px')).toBe(true)
    // The bubble's opener is the slot: the keyboard lands on the row, the first control.
    expect(document.activeElement).toBe(row)
  })

  it('puts the registrable domain on the never-sleep list, says so, and lets the bubble go', async () => {
    render(<MemorySaverBubble state={state({}, ['example.org'])} bubble={{ tabId: 't1' }} />)
    await settle()
    const row = bubble()!.querySelector<HTMLElement>('[data-never-unload]')!
    act(() => row.click())
    // The list grows by the domain, the rest kept; the core's `neverUnloaded` matches the page's
    // host `mail.google.com` by this registrable domain.
    expect(run).toHaveBeenCalledWith('settings.update', {
      unloadExcludedDomains: ['example.org', 'google.com']
    })
    // The chrome's status region carries the change (a11y-27).
    expect(announcerStore.get().text).toBe('google.com will not be unloaded')
    // The bubble leaves on its spring and clears its own state as it lands.
    await act(async () => {
      await vi.waitFor(() => expect(uiStore.get().memorySaverBubble).toBeNull())
    })
  })

  it('offers no row for a site already on the list, and none in a private window', async () => {
    render(<MemorySaverBubble state={state({}, ['Google.com'])} bubble={{ tabId: 't1' }} />)
    await settle()
    expect(bubble()).not.toBeNull()
    expect(bubble()!.querySelector('[data-never-unload]')).toBeNull()
    // Nothing below the title block, so no stray hairline either.
    expect(bubble()!.querySelector('.h-px')).toBeNull()
    act(() => root!.unmount())
    document.getElementById('zen-chrome-layer')?.remove()
    closeAllPopovers()

    render(
      <MemorySaverBubble
        state={state({
          window: { kind: 'private', fullscreen: false, htmlFullscreenTabId: null }
        } as Partial<UIState>)}
        bubble={{ tabId: 't1' }}
      />
    )
    await settle()
    expect(bubble()).not.toBeNull()
    expect(bubble()!.querySelector('#zen-memory-saver-title')?.textContent).toBe(
      'Memory Saver freed up 312 MB'
    )
    expect(bubble()!.querySelector('[data-never-unload]')).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('goes when the tab is no longer the one in front, or sleeps again', async () => {
    render(<MemorySaverBubble state={state()} bubble={{ tabId: 't1' }} />)
    await settle()
    expect(bubble()).not.toBeNull()
    // Another tab comes forward: the bubble spoke for a slot that is gone.
    const other = { ...page, id: 't2', memorySaver: null } as Tab
    act(() =>
      root!.render(
        <MemorySaverBubble
          state={state({
            tabs: { t1: page, t2: other },
            spaces: [{ ...space, tabIds: ['t1', 't2'], activeTabId: 't2' }]
          } as Partial<UIState>)}
          bubble={{ tabId: 't1' }}
        />
      )
    )
    await act(async () => {
      await vi.waitFor(() => expect(uiStore.get().memorySaverBubble).toBeNull())
    })
  })
})
