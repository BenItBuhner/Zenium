// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState } from '@shared/types'

/*
 * The sidebar foot's plain toast row (`SidebarBottom`; the desktop's until the desktop program
 * adopts the §9.33 card). The row is one flex line that wraps: a message and an action that fit
 * the line render as they always have – the message first, growing into the room the action
 * leaves, the action a v2 secondary button after it – and a message the line cannot hold beside
 * its action takes the row's width and the action drops under it, right-aligned. The first
 * automatic picture-in-picture toast (MW-28, "Video from <site> opened in a small window" ·
 * "Turn off for this site") is the one that made the row wrap a word per line; the wrap is the
 * row's own (`flex-wrap`, the message `flex-auto`, the action `ml-auto`), so no toast's markup
 * changes. Layout is not measurable here; the classes are the contract, the stills the proof.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { defaultShortcuts } = await import('@shared/shortcuts')
const { DEFAULT_CONTAINER_ID } = await import('@shared/types')
const { SidebarBottom } = await import('../SidebarBottom')

function state(): UIState {
  const space = {
    id: 'space',
    name: 'Home',
    icon: '',
    containerId: DEFAULT_CONTAINER_ID,
    theme: null,
    tabIds: [],
    activeTabId: null,
    pinnedCollapsed: false
  }
  return {
    platform: 'linux',
    capabilities: { windowControls: false },
    window: { kind: 'synced', fullscreen: false, htmlFullscreenTabId: null },
    tabs: {},
    spaces: [space],
    activeSpaceId: 'space',
    folders: {},
    liveFolders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    agents: [],
    containers: [],
    media: [],
    boosts: [],
    extensions: [],
    bookmarks: [],
    downloads: [],
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
    shortcuts: defaultShortcuts('linux', 'chrome'),
    blockedPopups: {},
    permissionRules: [],
    translate: { available: true, tabs: {} },
    securityPrompts: [],
    autofill: { prompts: [], picker: null },
    settings: { sidebarExpanded: true, sidebarSide: 'left', toolbarLayout: 'single' }
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
  return mount!
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  uiStore.set({ toasts: [] })
})

function toast(message: string, action?: { label: string; onPick: () => void }): void {
  browserStore.set({ state: state() })
  uiStore.set({ toasts: [{ id: 1, message, kind: 'info', duration: 5000, action }] })
  render(<SidebarBottom state={state()} compact={false} isDark={false} />)
}

const classes = (el: Element): string[] => [...el.classList]

describe('the sidebar toast row', () => {
  it('is one status row that may wrap: the message first and growing, the action after it, right-aligned when it drops under', () => {
    const onPick = vi.fn()
    toast('Bookmark deleted', { label: 'Undo', onPick })
    const row = document.querySelector('.zen-toast')!
    expect(row.getAttribute('role')).toBe('status')
    // The message, then the action: the same two children the row has always had.
    expect([...row.children].map((c) => c.tagName)).toEqual(['SPAN', 'BUTTON'])
    expect(row.children[0]!.textContent).toBe('Bookmark deleted')
    expect(row.children[1]!.textContent).toBe('Undo')
    // The row wraps, the message's own width decides where (`flex-auto`, not the 0-basis
    // `flex-1` that shrank it beside the action), and the action's auto margin puts it at the
    // right edge of a line of its own.
    expect(classes(row)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'items-center']))
    expect(classes(row.children[0]!)).toEqual(expect.arrayContaining(['min-w-0', 'flex-auto']))
    expect(classes(row.children[0]!)).not.toContain('flex-1')
    expect(classes(row.children[1]!)).toEqual(
      expect.arrayContaining(['zen-v2', 'zen-v2-button', 'ml-auto', 'shrink-0'])
    )
    // The pick runs the action and takes the toast down, as before.
    act(() => (row.children[1] as HTMLButtonElement).click())
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(uiStore.get().toasts).toEqual([])
  })

  it('draws the first automatic picture-in-picture toast (MW-28) with the same markup – the wrap is the row’s, not the toast’s', () => {
    toast('Video from video.example opened in a small window', {
      label: 'Turn off for this site',
      onPick: () => undefined
    })
    const row = document.querySelector('.zen-toast')!
    expect([...row.children].map((c) => [c.tagName, c.textContent])).toEqual([
      ['SPAN', 'Video from video.example opened in a small window'],
      ['BUTTON', 'Turn off for this site']
    ])
    expect(classes(row)).toContain('flex-wrap')
  })

  it('is the message alone without an action', () => {
    toast('Copied')
    const row = document.querySelector('.zen-toast')!
    expect([...row.children].map((c) => c.tagName)).toEqual(['SPAN'])
    expect(row.querySelector('button')).toBeNull()
  })
})
