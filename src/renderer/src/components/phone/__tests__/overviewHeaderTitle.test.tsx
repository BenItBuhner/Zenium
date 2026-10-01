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
import { OVERVIEW_TITLE_TESTID, OverviewTitle, TITLE_FADE_MS } from '../OverviewHeader'
import { PANE_FADE_MS } from '../PaneSlot'

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

/*
 * §6: at a space switch (GN-19's swipe, the Spaces sheet, the menu's Switch Space) the title's
 * words cross-fade over 120 ms, the pane's fade – the words that were kept over the new ones as
 * a still fading out (opacity alone, `.zen-overview-title-still` in main.css), the new ones
 * beneath from the first frame. Nothing of the sort within one space: a count that changes
 * there is a cut, as the grid's card count is.
 */
describe('the title at a space switch (§6)', () => {
  const STILL = '[data-testid="overview-title-still"]'
  /** The words that stand live: the title's `.zen-title` outside any still. */
  const live = (): string => {
    const title = q<HTMLElement>(`[data-testid="${OVERVIEW_TITLE_TESTID}"]`)!
    const words = [...title.querySelectorAll<HTMLElement>('.zen-title')].filter(
      (w) => !w.closest(STILL)
    )
    expect(words).toHaveLength(1)
    return words[0]!.textContent!.replace(/\s+/g, ' ').trim()
  }
  const titleFor = (sp: Space, count: number): ReactElement => (
    <OverviewTitle
      view="tabs"
      space={sp}
      count={count}
      spacesOpen={false}
      onOpenSpaces={() => undefined}
    />
  )

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fades the words that were over the new ones for the pane’s 120 ms, the name new at once', () => {
    vi.useFakeTimers()
    expect(TITLE_FADE_MS).toBe(120)
    expect(TITLE_FADE_MS).toBe(PANE_FADE_MS)
    const work = space('work', 'Work', [])
    const personal = space('personal', 'Personal', [])
    render(titleFor(work, 10))
    expect(q(STILL)).toBeNull()
    render(titleFor(personal, 5))
    const title = q<HTMLButtonElement>(`[data-testid="${OVERVIEW_TITLE_TESTID}"]`)!
    // TalkBack and the live words are the new space's from the first frame …
    expect(title.getAttribute('aria-label')).toBe('Personal, 5 tabs')
    const still = q<HTMLElement>(STILL)!
    expect(still).not.toBeNull()
    // … the still is the old words, out of the accessibility tree, laid over them.
    expect(still.getAttribute('aria-hidden')).toBe('true')
    expect(still.textContent?.replace(/\s+/g, ' ').trim()).toBe('Work · 10 tabs')
    expect(still.classList.contains('zen-overview-title-still')).toBe(true)
    expect(live()).toBe('Personal · 5 tabs')
    // The button stays the row's one control through the fade.
    expect(title.querySelectorAll('button, [role="button"]')).toHaveLength(0)
    act(() => {
      vi.advanceTimersByTime(TITLE_FADE_MS - 1)
    })
    expect(q(STILL)).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(q(STILL)).toBeNull()
    expect(live()).toBe('Personal · 5 tabs')
  })

  it('a second switch inside the fade restarts it from the words that stood', () => {
    vi.useFakeTimers()
    const work = space('work', 'Work', [])
    const personal = space('personal', 'Personal', [])
    const reading = space('reading', 'Reading', [])
    render(titleFor(work, 10))
    render(titleFor(personal, 5))
    act(() => {
      vi.advanceTimersByTime(60)
    })
    render(titleFor(reading, 2))
    const stills = document.querySelectorAll(STILL)
    expect(stills).toHaveLength(1)
    expect(stills[0]!.textContent?.replace(/\s+/g, ' ').trim()).toBe('Personal · 5 tabs')
    act(() => {
      vi.advanceTimersByTime(TITLE_FADE_MS - 1)
    })
    expect(q(STILL)).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(q(STILL)).toBeNull()
    expect(live()).toBe('Reading · 2 tabs')
  })

  it('a count that changes within one space is a cut: no still', () => {
    vi.useFakeTimers()
    const work = space('work', 'Work', [])
    render(titleFor(work, 10))
    render(titleFor(work, 9))
    expect(q(STILL)).toBeNull()
    expect(live()).toBe('Work · 9 tabs')
    // And none at the first render of a space, which is no switch.
    render(titleFor({ ...work, name: 'Work' }, 9))
    expect(q(STILL)).toBeNull()
  })
})
