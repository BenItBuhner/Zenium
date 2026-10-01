// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { PRIVATE_CONTAINER_ID } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import {
  overviewCount,
  overviewTabCount,
  overviewTitle,
  overviewTitleLabel,
  tabsWord
} from '@renderer/lib/overviewHeader'
import { OVERVIEW_TITLE_TESTID, OverviewTitle } from '../OverviewHeader'

/*
 * The tab overview's one header row (tab overview cleanup spec §1, §3): the space's dot and
 * name with the count – "Default · 3 tabs" – and nothing trailing it; THE TITLE IS THE SPACE
 * SWITCHER (a button, a dialog popping up, named without the typographic dot for TalkBack);
 * in the private view the mask and "Private · N tabs", no control. And the count's words: the
 * cards the regular grid shows – Essentials, pinned, regular; never a private one (TAB-02).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function tab(id: string, spaceId: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId,
    containerId: 'default',
    url: `https://${id}.example/`,
    title: id,
    folderId: null,
    pinned: false,
    essential: false,
    ...over
  } as Tab
}

function space(id: string, name: string, tabs: Tab[], over: Partial<Space> = {}): Space {
  return {
    id,
    name,
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null,
    pinnedCollapsed: false,
    ...over
  } as Space
}

function stateOf(spaces: Space[], tabs: Tab[], essentialTabIds: string[] = []): UIState {
  return {
    platform: 'android',
    capabilities: { windowControls: false, privateTabs: true },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces,
    activeSpaceId: spaces[0]!.id,
    folders: {},
    essentialTabIds,
    containers: [],
    settings: { ...DEFAULT_SETTINGS }
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLDivElement | null = null

function render(el: ReactElement): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
})

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)

describe('the header’s words (§1, §3)', () => {
  it('counts the regular grid’s cards – Essentials, pinned, regular – and never a private tab', () => {
    const regular = [tab('a', 'work'), tab('b', 'work', { pinned: true })]
    const secret = tab('p', 'work', { containerId: PRIVATE_CONTAINER_ID })
    const essential = tab('e', 'work', { essential: true })
    const work = space('work', 'Work', [...regular, secret])
    const state = stateOf([work], [...regular, secret, essential], ['e'])
    expect(overviewTabCount(state, work)).toBe(3)
    expect(overviewCount(state, work, 'tabs')).toBe(3)
    // The private view counts the private session across the spaces.
    expect(overviewCount(state, work, 'private')).toBe(1)
  })

  it('writes the title and its count in the words the row shows and the name TalkBack reads', () => {
    expect(tabsWord(1)).toBe('1 tab')
    expect(tabsWord(3)).toBe('3 tabs')
    expect(tabsWord(0)).toBe('0 tabs')
    expect(overviewTitle('tabs', { name: 'Default' })).toBe('Default')
    expect(overviewTitle('private', { name: 'Default' })).toBe('Private')
    expect(overviewTitleLabel('Default', 3)).toBe('Default, 3 tabs')
  })
})

describe('the title control (§1)', () => {
  it('is one button – the space’s glyph, "Default · 3 tabs" – named without the dot, a dialog popping up', () => {
    const opened: number[] = []
    const work = space('work', 'Default', [], { icon: '' })
    render(
      <OverviewTitle
        view="tabs"
        space={work}
        count={3}
        dotColor="#3366ff"
        spacesOpen={false}
        onOpenSpaces={() => opened.push(1)}
      />
    )
    const title = q<HTMLButtonElement>(`[data-testid="${OVERVIEW_TITLE_TESTID}"]`)!
    expect(title.tagName).toBe('BUTTON')
    expect(title.getAttribute('aria-label')).toBe('Default, 3 tabs')
    expect(title.getAttribute('aria-haspopup')).toBe('dialog')
    expect(title.getAttribute('aria-expanded')).toBe('false')
    expect(title.dataset.view).toBe('tabs')
    // The face: the words, the name in the title's 17/600 (`zen-title`), the count after the dot.
    expect(title.textContent?.replace(/\s+/g, ' ').trim()).toBe('Default · 3 tabs')
    expect(title.querySelector('.zen-title')).not.toBeNull()
    expect(q('[data-testid="overview-count"]')?.textContent).toBe('3 tabs')
    // The space's dot in the theme's accent, as the drawer's rows draw it.
    const dot = title.firstElementChild as HTMLElement
    expect(dot.style.background.toLowerCase()).toMatch(/#3366ff|51, 102, 255/)
    // Nothing trails the title: the button is the row's one control.
    expect(title.querySelectorAll('button, [role="button"]')).toHaveLength(0)
    act(() => title.click())
    expect(opened).toHaveLength(1)
    render(
      <OverviewTitle
        view="tabs"
        space={work}
        count={3}
        spacesOpen
        onOpenSpaces={() => opened.push(1)}
      />
    )
    expect(title.getAttribute('aria-expanded')).toBe('true')
  })

  it('in the private view reads the mask and "Private · N tabs" and is no control (§3)', () => {
    const work = space('work', 'Default', [])
    render(
      <OverviewTitle
        view="private"
        space={work}
        count={1}
        spacesOpen={false}
        onOpenSpaces={() => undefined}
      />
    )
    const title = q<HTMLElement>(`[data-testid="${OVERVIEW_TITLE_TESTID}"]`)!
    expect(title.tagName).not.toBe('BUTTON')
    expect(title.getAttribute('role')).toBe('heading')
    expect(title.getAttribute('aria-label')).toBe('Private, 1 tab')
    expect(title.dataset.view).toBe('private')
    expect(title.textContent?.replace(/\s+/g, ' ').trim()).toBe('Private · 1 tab')
    expect(title.querySelector('svg')).not.toBeNull()
    expect(document.querySelectorAll('button')).toHaveLength(0)
  })
})
