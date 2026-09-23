// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { viewportStore } from '@renderer/lib/formFactor'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { SpacePanel } from '../SpacePanel'
import { StripAxisContext } from '../stripAxis'

/*
 * The group row's inline rename (`FolderRename`, the tablet sidebar; TABLET-04, nightly
 * `tablet-groups` §6): the field stays until Enter (commit), Escape (cancel) or the focus moving
 * to another chrome control. A blur the HOST caused – the chrome document itself lost the focus,
 * so no `relatedTarget` and `document.hasFocus()` false, the shape of the host's focus move
 * landing on the page a frame after the mount – does not commit it: the field keeps its text,
 * the name in the core stays as it was, and the next Enter renames. A blur onto another chrome
 * control, and a tap on the chrome's own background (no target, the document still focused),
 * commit as they always did.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/`,
    title: id.toUpperCase(),
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    progress: 0,
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
    ...over
  } as Tab
}

const research: Folder = {
  id: 'g',
  spaceId: 'space',
  name: 'Research',
  icon: '📁',
  color: 'blue',
  collapsed: false
} as Folder

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
}

/** The tablet panel with Research [Alpha, Beta] and the loose Home, the group being renamed. */
function panelRenaming(): void {
  const tabs = [tab('home'), tab('alpha', { folderId: 'g' }), tab('beta', { folderId: 'g' })]
  const space: Space = {
    id: 'space',
    name: 'Work',
    icon: '',
    containerId: DEFAULT_CONTAINER_ID,
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: 'home',
    pinnedCollapsed: false
  }
  const state = {
    platform: 'android',
    window: { kind: 'synced' },
    capabilities: { privateTabs: true },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: 'space',
    folders: { g: research },
    liveFolders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    agents: [],
    containers: [],
    media: [],
    settings: { showTabSeparator: false }
  } as unknown as UIState
  browserStore.set({ state })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'tablet', coarse: true, hover: false })
  uiStore.set({ renamingFolderId: 'g' })
  render(
    <StripAxisContext.Provider value="y">
      <SpacePanel state={state} space={space} isActive compact={false} />
    </StripAxisContext.Provider>
  )
}

const header = (): HTMLElement => document.querySelector<HTMLElement>('[data-tab-folder="g"]')!
const field = (): HTMLInputElement | null =>
  header()?.querySelector<HTMLInputElement>('input') ?? null

/** A blur of the field with `relatedTarget` – React's `onBlur` listens to `focusout`. */
function blur(relatedTarget: Element | null): void {
  act(() => {
    field()!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget }))
  })
}

function key(k: string): void {
  act(() => {
    field()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
    )
  })
}

function type(text: string): void {
  act(() => {
    const input = field()!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const renames = (): unknown[][] =>
  vi.mocked(run).mock.calls.filter(([name]) => name === 'folder.update')

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  browserStore.set({ state: null })
  uiStore.set({ selectedTabIds: [], drag: null, renamingFolderId: null })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false, hover: true })
  vi.mocked(run).mockClear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FolderRename and a blur the host caused', () => {
  it('mounts focused with the name, and a host-caused blur leaves it mounted, its text kept, the name unchanged', () => {
    panelRenaming()
    expect(document.activeElement).toBe(field())
    expect(field()!.value).toBe('Research')
    type('Reading')
    // The host moved the focus to the page's view: the chrome document lost the focus, the blur
    // names no chrome control.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    blur(null)
    expect(field()).not.toBeNull()
    expect(field()!.value).toBe('Reading')
    expect(uiStore.get().renamingFolderId).toBe('g')
    expect(renames()).toEqual([])
    // The chrome focused again, the user finishes: Enter renames.
    vi.restoreAllMocks()
    key('Enter')
    expect(field()).toBeNull()
    expect(uiStore.get().renamingFolderId).toBeNull()
    expect(renames()).toEqual([['folder.update', { folderId: 'g', patch: { name: 'Reading' } }]])
  })

  it('Enter commits the typed name and the field leaves', () => {
    panelRenaming()
    type('Reading')
    key('Enter')
    expect(field()).toBeNull()
    expect(renames()).toEqual([['folder.update', { folderId: 'g', patch: { name: 'Reading' } }]])
  })

  it('Escape leaves the name as it was and the field leaves', () => {
    panelRenaming()
    type('Reading')
    key('Escape')
    expect(field()).toBeNull()
    expect(uiStore.get().renamingFolderId).toBeNull()
    expect(renames()).toEqual([])
  })

  it('the focus moving to another chrome control commits, as before', () => {
    panelRenaming()
    type('Reading')
    const other = document.createElement('button')
    document.body.appendChild(other)
    blur(other)
    expect(field()).toBeNull()
    expect(renames()).toEqual([['folder.update', { folderId: 'g', patch: { name: 'Reading' } }]])
    other.remove()
  })

  it('a tap on the chrome’s own background – no target, the document still focused – commits, as before', () => {
    panelRenaming()
    type('Reading')
    expect(document.hasFocus()).toBe(true)
    blur(null)
    expect(field()).toBeNull()
    expect(renames()).toEqual([['folder.update', { folderId: 'g', patch: { name: 'Reading' } }]])
  })

  it('a host-caused blur with the name untouched keeps the field too, and Escape then leaves it without a rename', () => {
    panelRenaming()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    blur(null)
    expect(field()).not.toBeNull()
    expect(renames()).toEqual([])
    vi.restoreAllMocks()
    key('Escape')
    expect(field()).toBeNull()
    expect(renames()).toEqual([])
  })
})
