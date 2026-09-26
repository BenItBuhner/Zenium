// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SearchChoiceState, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import { shuffledSearchChoiceTiles } from '@core/searchChoice'

/*
 * The EEA's search-engine choice screen (W6-2; DMA Art. 6(3)) as the desktop draws it: the
 * tour's search step in the EEA – the eligible engines in the run's order, nothing picked,
 * "Set as default" live once a tile is picked, "Skip for now" and Escape recording nothing –
 * and the same chassis on its own after the tour while the screen is owed; outside the EEA the
 * tour's step keeps its three tiles; the URL bar waits under the screen as it waits under the
 * tour. The phone draws the screen in its own pose (OMN-26; `PhoneOnboarding.tsx`,
 * `PhoneSearchChoice.tsx`) on the same model and terms.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { Onboarding } = await import('../Onboarding')
const { SearchChoiceScreen } = await import('../SearchChoice')
const { browserStore, firstRunCovers, onboardingUp, openNewTabPageUrlbar, uiStore } =
  await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { onboardingCovers } = await import('@renderer/lib/onboarding')
const { searchChoiceCovers, tourAsksSearchChoice } = await import('@renderer/lib/searchChoice')

const SEED = 0x5eed
const EEA: SearchChoiceState = { region: 'DE', eea: true, required: true, seed: SEED }
const ELSEWHERE: SearchChoiceState = { region: 'US', eea: false, required: false, seed: SEED }
const ANSWERED: SearchChoiceState = { region: 'DE', eea: true, required: false, seed: SEED }

function tab(id: string): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: 'default',
    url: 'zen://newtab',
    title: 'New Tab',
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
}

/** The profile window's state, with the choice screen's terms. */
function profile(
  onboardingDone: boolean,
  searchChoice: SearchChoiceState,
  window: Partial<UIState['window']> = {}
): UIState {
  return {
    platform: 'linux',
    capabilities: {},
    tabs: { t1: tab('t1') },
    spaces: [{ id: 'space', activeTabId: 't1', tabIds: ['t1'], theme: null }],
    activeSpaceId: 'space',
    essentialTabIds: [],
    folders: {},
    settings: { ...DEFAULT_SETTINGS, onboardingDone, searchEngineId: 'google' },
    searchEngines: DEFAULT_SEARCH_ENGINES,
    searchChoice,
    shortcuts: [],
    systemDark: false,
    window: {
      kind: 'synced',
      chrome: 'full',
      fullscreen: false,
      htmlFullscreenTabId: null,
      ...window
    }
  } as unknown as UIState
}

/** What the desktop shell mounts of the two, on its terms. */
function Shell(): JSX.Element | null {
  const state = browserStore.use((s) => s.state)
  if (!state) return null
  const onboarding = onboardingCovers(state)
  return createElement(
    'div',
    null,
    onboarding && createElement(Onboarding, { state }),
    !onboarding && searchChoiceCovers(state) && createElement(SearchChoiceScreen, { state })
  )
}

let root: Root | null = null
let host: HTMLElement | null = null

async function mount(state: UIState): Promise<void> {
  browserStore.set({ state })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(Shell)))
}

const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
const commands = (): Array<[string, unknown]> =>
  invoke.mock.calls.map(([name, args]) => [name, args])
const q = <T extends Element>(selector: string): T | null => document.querySelector<T>(selector)
const rows = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('[role="radio"].zen-search-choice-row')
]
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)
const setDefault = (): HTMLButtonElement =>
  q<HTMLButtonElement>('[data-testid="search-choice-set"]')!

/** A click as Chromium delivers it: the button takes the focus, then is activated. */
async function click(b: HTMLButtonElement | undefined): Promise<void> {
  if (!b) throw new Error('no such button')
  await act(async () => {
    b.focus()
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

async function key(target: EventTarget, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

/** Through the tour's first two steps to the search step. */
async function toSearchStep(): Promise<void> {
  await click(button('Continue'))
  await click(button('Continue'))
}

/** From the step after the search step to the tour's end: Continue through the rest, then Start browsing. */
async function toTourEnd(): Promise<void> {
  for (let guard = 0; guard < 8 && button('Continue'); guard++) await click(button('Continue'))
  await click(button('Start browsing'))
}

/** The `onboarding.complete` the tour's end sent. */
const completion = (): { searchEngineId: string } | undefined =>
  commands().find(([n]) => n === 'onboarding.complete')?.[1] as
    { searchEngineId: string } | undefined

/** An EEA profile that already has an engine of its own – what a skip must leave standing. */
function eeaProfileWith(engineId: string, searchChoice: SearchChoiceState = EEA): UIState {
  const state = profile(false, searchChoice)
  return { ...state, settings: { ...state.settings, searchEngineId: engineId } }
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: false, tabId: null } }))
  browserStore.set({ state: null })
  invoke.mockClear()
})

describe('the tour’s search step in the EEA', () => {
  it('is the choice screen: the run’s order, nothing picked, Set as default off, no Skip tour', async () => {
    await mount(profile(false, EEA))
    await toSearchStep()

    expect(q('[data-testid="search-choice"]')).not.toBeNull()
    expect(q('h2')?.textContent).toBe('Choose your search engine')
    const group = q<HTMLElement>('[role="radiogroup"]')!
    expect(group.getAttribute('aria-labelledby')).toBe(q('h2')!.id)
    // Germany's list (Chrome's table) in the run's order, from the state's seed – each tile the
    // engine's name, its own line and the icon bundled with the chrome (no request to the
    // engine before the choice; never a picture inlined into the script).
    const expected = shuffledSearchChoiceTiles('DE', SEED)
    expect(rows().map((r) => r.dataset.engine)).toEqual(expected.map((t) => t.engine.id))
    expect(rows()).toHaveLength(8)
    expect(
      rows()
        .map((r) => r.dataset.engine)
        .sort()
    ).toEqual(
      ['google', 'duckduckgo', 'brave', 'ecosia', 'bing', 'startpage', 'yahoo_de', 'qwant'].sort()
    )
    rows().forEach((r, i) => {
      expect(r.getAttribute('aria-checked')).toBe('false')
      expect(r.querySelector('.zen-search-choice-name')?.textContent).toBe(expected[i]!.engine.name)
      expect(r.querySelector('.zen-search-choice-tagline')?.textContent).toBe(expected[i]!.tagline)
      const icon = r.querySelector<HTMLImageElement>('.zen-search-choice-icon > img')
      expect(icon, expected[i]!.engine.id).not.toBeNull()
      expect(icon!.getAttribute('src')).toMatch(/search-engines\/[a-z]+\.png/)
      expect(icon!.getAttribute('src')).not.toMatch(/^(https?:|data:)/)
      expect(r.querySelector('.zen-search-choice-letter')).toBeNull()
    })
    // Nothing chosen for the user: the primary waits; the plain verb stands at the same size
    // as its peers (§6: one button height, 32 – never the small variant beside Back and Set).
    expect(setDefault().disabled).toBe(true)
    const skip = button('Skip for now')!
    expect(skip).not.toBeUndefined()
    expect(skip.className).toContain('h-8')
    expect(skip.className).not.toMatch(/\bh-7\b|text-xs/)
    expect(setDefault().className).toContain('h-8')
    expect(button('Back')!.className).toContain('h-8')
    expect(button('Skip tour')).toBeUndefined()
    expect(button('Continue')).toBeUndefined()
    expect(commands().map(([n]) => n)).not.toContain('searchChoice.choose')
  })

  it('a pick lights Set as default; Set as default tells the core and goes on', async () => {
    await mount(profile(false, EEA))
    await toSearchStep()

    const pick = rows().find((r) => r.dataset.engine === 'duckduckgo')!
    await click(pick)
    expect(pick.getAttribute('aria-checked')).toBe('true')
    expect(rows().filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    expect(setDefault().disabled).toBe(false)

    // Another pick moves the mark – one choice at a time.
    const other = rows().find((r) => r.dataset.engine === 'bing')!
    await click(other)
    expect(pick.getAttribute('aria-checked')).toBe('false')
    expect(other.getAttribute('aria-checked')).toBe('true')

    await click(setDefault())
    expect(commands()).toContainEqual(['searchChoice.choose', { engineId: 'bing' }])
    expect(commands().map(([n]) => n)).not.toContain('searchChoice.skip')
    // The tour goes on past the step.
    expect(q('[data-testid="search-choice"]')).toBeNull()
    expect(q('[data-testid="onboarding"]')).not.toBeNull()
  })

  it('Back after Set or Skip returns to the answered choice step with its pick – the step is settled when the tour mounts', async () => {
    await mount(profile(false, EEA))
    await toSearchStep()
    await click(rows().find((r) => r.dataset.engine === 'ecosia'))
    await click(setDefault())
    // The core answers: the choice is no longer owed. The tour's step must not turn into the
    // other form (the three tiles with the shipped default picked) under the user's feet.
    await act(async () => browserStore.set({ state: profile(false, ANSWERED) }))
    expect(tourAsksSearchChoice(profile(false, ANSWERED))).toBe(false)
    await click(button('Back'))
    expect(q('[data-testid="search-choice"]')).not.toBeNull()
    expect(q('h2')?.textContent).toBe('Choose your search engine')
    expect(button('Continue')).toBeUndefined()
    const checked = rows().filter((r) => r.getAttribute('aria-checked') === 'true')
    expect(checked.map((r) => r.dataset.engine)).toEqual(['ecosia'])
    expect(setDefault().disabled).toBe(false)

    // The same after a skip – with a tile picked first: the skip lets the pick go (§9.39), so
    // the step comes back with nothing picked and Set as default off again.
    act(() => root?.unmount())
    host?.remove()
    invoke.mockClear()
    await mount(profile(false, EEA))
    await toSearchStep()
    await click(rows().find((r) => r.dataset.engine === 'qwant'))
    expect(setDefault().disabled).toBe(false)
    await click(button('Skip for now'))
    expect(commands()).toContainEqual(['searchChoice.skip', undefined])
    expect(commands().map(([n]) => n)).not.toContain('searchChoice.choose')
    await act(async () => browserStore.set({ state: profile(false, ANSWERED) }))
    await click(button('Back'))
    expect(q('[data-testid="search-choice"]')).not.toBeNull()
    expect(rows().every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(setDefault().disabled).toBe(true)
    expect(button('Skip for now')).not.toBeUndefined()
    expect(button('Skip tour')).toBeUndefined()
  })

  it('Skip for now and Escape record nothing – the core hears a skip – and the tour goes on', async () => {
    await mount(profile(false, EEA))
    await toSearchStep()
    await click(button('Skip for now'))
    expect(commands()).toContainEqual(['searchChoice.skip', undefined])
    expect(commands().map(([n]) => n)).not.toContain('searchChoice.choose')
    expect(q('[data-testid="search-choice"]')).toBeNull()
    expect(q('[data-testid="onboarding"]')).not.toBeNull()
    invoke.mockClear()

    // Escape on the step, wherever the keyboard is.
    act(() => root?.unmount())
    host?.remove()
    await mount(profile(false, EEA))
    await toSearchStep()
    await key(window, 'Escape')
    expect(commands()).toContainEqual(['searchChoice.skip', undefined])
    expect(q('[data-testid="search-choice"]')).toBeNull()
  })

  it('a tile picked and then Skip for now is let go: the tour’s end installs the profile’s engine, not the pick, and the core never hears a choose (§9.39)', async () => {
    await mount(eeaProfileWith('duckduckgo'))
    await toSearchStep()
    await click(rows().find((r) => r.dataset.engine === 'qwant'))
    expect(setDefault().disabled).toBe(false)
    await click(button('Skip for now'))
    expect(commands()).toContainEqual(['searchChoice.skip', undefined])
    // The core answers the skip: the screen is not owed for the rest of this run; the profile's
    // engine stands as it was.
    await act(async () => browserStore.set({ state: eeaProfileWith('duckduckgo', ANSWERED) }))
    await toTourEnd()
    expect(completion()?.searchEngineId).toBe('duckduckgo')
    expect(commands().map(([n]) => n)).not.toContain('searchChoice.choose')
  })

  it('the same through Escape on the step: the pick is let go, the tour’s end installs the profile’s engine (§9.39)', async () => {
    await mount(eeaProfileWith('duckduckgo'))
    await toSearchStep()
    await click(rows().find((r) => r.dataset.engine === 'qwant'))
    expect(rows().filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    await key(window, 'Escape')
    expect(commands()).toContainEqual(['searchChoice.skip', undefined])
    expect(q('[data-testid="search-choice"]')).toBeNull()
    await act(async () => browserStore.set({ state: eeaProfileWith('duckduckgo', ANSWERED) }))
    await toTourEnd()
    expect(completion()?.searchEngineId).toBe('duckduckgo')
    expect(commands().map(([n]) => n)).not.toContain('searchChoice.choose')
  })

  it('arrow keys move the pick as a radio group’s do; Space picks the focused row', async () => {
    await mount(profile(false, EEA))
    await toSearchStep()
    const [first, second] = rows()
    // One tab stop while nothing is picked: the first row.
    expect(first!.tabIndex).toBe(0)
    expect(second!.tabIndex).toBe(-1)
    await key(first!, 'ArrowDown')
    expect(second!.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(second)
    await key(second!, 'ArrowUp')
    expect(first!.getAttribute('aria-checked')).toBe('true')
    await key(first!, 'End')
    expect(rows().at(-1)!.getAttribute('aria-checked')).toBe('true')
    await key(rows().at(-1)!, 'ArrowDown')
    expect(first!.getAttribute('aria-checked')).toBe('true')
    // The picked row is the group's one tab stop.
    expect(first!.tabIndex).toBe(0)
    expect(rows().at(-1)!.tabIndex).toBe(-1)
    expect(setDefault().disabled).toBe(false)
  })

  it('outside the EEA the step keeps its three tiles with the shipped default picked', async () => {
    await mount(profile(false, ELSEWHERE))
    await toSearchStep()
    expect(tourAsksSearchChoice(profile(false, ELSEWHERE))).toBe(false)
    expect(q('[data-testid="search-choice"]')).toBeNull()
    expect(q('h2')?.textContent).toBe('Pick a search engine')
    expect(button('Continue')).not.toBeUndefined()
    expect(button('Skip tour')).not.toBeUndefined()
    expect(button('Set as default')).toBeUndefined()
  })
})

describe('the screen on its own', () => {
  it('stands over the profile window after the tour while the screen is owed – not over other windows, not when answered', () => {
    expect(searchChoiceCovers(profile(true, EEA))).toBe(true)
    // Before the tour is done the tour's step is the screen.
    expect(searchChoiceCovers(profile(false, EEA))).toBe(false)
    expect(searchChoiceCovers(profile(true, ANSWERED))).toBe(false)
    expect(searchChoiceCovers(profile(true, ELSEWHERE))).toBe(false)
    expect(searchChoiceCovers(profile(true, EEA, { kind: 'private' }))).toBe(false)
    expect(searchChoiceCovers(profile(true, EEA, { kind: 'unsynced' }))).toBe(false)
    expect(searchChoiceCovers(profile(true, EEA, { chrome: 'popup' }))).toBe(false)
    expect(searchChoiceCovers(profile(true, EEA, { chrome: 'app' }))).toBe(false)
    // A state without the field (an older core): nothing is owed.
    expect(
      searchChoiceCovers({ ...profile(true, EEA), searchChoice: undefined } as unknown as UIState)
    ).toBe(false)
  })

  it('draws the one step in the tour’s chassis, takes the keyboard, and answers through the core', async () => {
    await mount(profile(true, EEA))
    const screen = q<HTMLElement>('[data-testid="search-choice-screen"]')
    expect(screen).not.toBeNull()
    expect(q('[data-testid="onboarding"]')).toBeNull()
    const dialog = q<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // Labelled by its visible title (§9.22), not by a second copy of the words.
    const title = q<HTMLHeadingElement>('h2')!
    expect(title.textContent).toBe('Choose your search engine')
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
    expect(dialog.hasAttribute('aria-label')).toBe(false)
    expect(q<HTMLElement>('[role="radiogroup"]')!.getAttribute('aria-labelledby')).toBe(title.id)
    expect(document.activeElement).toBe(dialog)
    // One step: no progress spans, no Back.
    expect(button('Back')).toBeUndefined()
    expect(button('Continue')).toBeUndefined()
    expect(rows().every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(setDefault().disabled).toBe(true)

    await click(rows().find((r) => r.dataset.engine === 'qwant'))
    expect(setDefault().disabled).toBe(false)
    await click(setDefault())
    expect(commands()).toContainEqual(['searchChoice.choose', { engineId: 'qwant' }])

    // The core answers with the record: the screen goes with it.
    await act(async () => browserStore.set({ state: profile(true, ANSWERED) }))
    expect(q('[data-testid="search-choice-screen"]')).toBeNull()
  })

  it('Escape and Skip for now are a skip; the screen stays until the core says otherwise', async () => {
    await mount(profile(true, EEA))
    await key(window, 'Escape')
    expect(commands()).toContainEqual(['searchChoice.skip', undefined])
    // Nothing is picked or written by the chrome itself.
    expect(q('[data-testid="search-choice-screen"]')).not.toBeNull()
    invoke.mockClear()
    await click(button('Skip for now'))
    expect(commands()).toEqual([['searchChoice.skip', undefined]])
    // The core's state (the skip held for the run) takes the screen down.
    await act(async () => browserStore.set({ state: profile(true, ANSWERED) }))
    expect(q('[data-testid="search-choice-screen"]')).toBeNull()
  })

  it('holds the URL bar as the tour does: the new tab’s bar waits until the screen is answered', async () => {
    await mount(profile(true, EEA))
    expect(onboardingUp()).toBe(true)
    openNewTabPageUrlbar('t1', undefined, false)
    await settle()
    expect(uiStore.get().urlbar.open).toBe(false)

    await act(async () => browserStore.set({ state: profile(true, ANSWERED) }))
    expect(onboardingUp()).toBe(false)
    openNewTabPageUrlbar('t1', undefined, false)
    await settle()
    expect(uiStore.get().urlbar).toMatchObject({ open: true, tabId: 't1' })
  })

  it('stands as the tour does for the page views: hidden under both (`firstRunCovers`); on the phone the screen alone', () => {
    // The tour, then the screen after it, then neither: the same terms the layout report reads
    // to hide the views under the opaque panel (`useLayoutReporter` `contentHidden`).
    expect(firstRunCovers(profile(false, EEA))).toBe(true)
    expect(firstRunCovers(profile(false, ELSEWHERE))).toBe(true)
    expect(firstRunCovers(profile(true, EEA))).toBe(true)
    expect(firstRunCovers(profile(true, ANSWERED))).toBe(false)
    expect(firstRunCovers(profile(true, ELSEWHERE))).toBe(false)
    expect(firstRunCovers(profile(true, EEA, { kind: 'private' }))).toBe(false)
    // The phone's tour is its shell's own flow over a first run with no page to hide; the
    // phone's screen standing on its own after the tour (OMN-26) may stand over a live page,
    // and hides it as the desktop's does.
    const before = viewportStore.get()
    viewportStore.set({ ...before, formFactor: 'phone' })
    try {
      expect(firstRunCovers(profile(false, EEA))).toBe(false)
      expect(firstRunCovers(profile(true, EEA))).toBe(true)
      expect(firstRunCovers(profile(true, ANSWERED))).toBe(false)
    } finally {
      viewportStore.set(before)
    }
  })
})

describe('the form factor', () => {
  it('the desktop and tablet shells mount the screen; the phone shell mounts its own (OMN-26)', () => {
    const read = (rel: string): string => readFileSync(resolve(__dirname, rel), 'utf8')
    expect(read('../../../App.tsx')).toMatch(/searchChoiceCovers\(state\)/)
    expect(read('../../../App.tsx')).toMatch(/<SearchChoiceScreen state=\{state\} \/>/)
    expect(read('../../tablet/TabletShell.tsx')).toMatch(/<SearchChoiceScreen state=\{state\} \/>/)
    const phone = read('../../phone/PhoneShell.tsx')
    expect(phone).toMatch(/searchChoiceCovers\(state\)/)
    expect(phone).toMatch(/<PhoneSearchChoiceScreen state=\{state\} \/>/)
    expect(phone).not.toMatch(/<SearchChoiceScreen/)
    expect(read('../PhoneOnboarding.tsx')).toMatch(/tourAsksSearchChoice\(state\)/)
    expect(read('../PhoneOnboarding.tsx')).not.toMatch(/<SearchChoiceStep/)
  })
})

describe('the stylesheet: equal tiles, one-line taglines, the list scrolls with the sixth row cut', () => {
  const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  )
  /** The declarations of the rule `selector {`, as `[property, value]` pairs. */
  const declarations = (selector: string): Array<[string, string]> => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = new RegExp(`(?<=^|\\n) *${escaped} \\{`).exec(css)
    expect(m, `rule "${selector}"`).not.toBeNull()
    const start = m!.index
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
    return [...body.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map((x) => [
      x[1]!,
      x[2]!.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()
    ])
  }
  const value = (selector: string, property: string): string | undefined =>
    declarations(selector).find(([p]) => p === property)?.[1]

  it('the list is a column that scrolls in its own box past five two-line rows, the sixth cut through its middle as the pull’s affordance (C6)', () => {
    expect(value('.zen-search-choice-list', 'display')).toBe('flex')
    expect(value('.zen-search-choice-list', 'flex-direction')).toBe('column')
    expect(value('.zen-search-choice-list', 'overflow-y')).toBe('auto')
    // 4 (the ring room above the first row, inside the scroll box) + 5 × 52 + 5 × 4 + 26 = 310: a
    // row cut through its middle, never a clean edge on a whole row (at 6 × 52 + 5 × 4 the fold
    // would land on the sixth row's foot and the list would read as complete).
    expect(value('.zen-search-choice-list', 'max-height')).toBe(
      'calc(var(--v2-ring-room) + 5 * var(--v2-row-two-line) + 5 * 4px + var(--v2-row-two-line) / 2)'
    )
    expect(value('.zen-search-choice-list', 'padding')).toBe('var(--v2-ring-room)')
    // The bar is the chassis's thin overlay (§9.20); the list sets none of its own.
    expect(css).not.toMatch(/\.zen-search-choice-list::-webkit-scrollbar/)
    expect(value('.zen-search-choice-list', 'scrollbar-width')).toBeUndefined()
  })

  it('every tile is the same 52: the tagline is one line of the engine’s own words, never a clamp or an ellipsis (C1)', () => {
    expect(value('.zen-search-choice-row', 'min-height')).toBe('var(--v2-row-two-line)')
    expect(value('.zen-search-choice-row', 'flex-shrink')).toBe('0')
    expect(value('.zen-search-choice-row', 'height')).toBeUndefined()
    expect(value('.zen-search-choice-tagline', 'white-space')).toBe('nowrap')
    expect(value('.zen-search-choice-tagline', '-webkit-line-clamp')).toBeUndefined()
    expect(value('.zen-search-choice-tagline', 'text-overflow')).toBeUndefined()
    expect(value('.zen-search-choice-tagline', 'overflow')).toBeUndefined()
    expect(value('.zen-search-choice-tagline', 'line-height')).toBe('var(--v2-line-small)')
  })

  it('the picked row’s fill is the accent at .12 – the window family’s tint, never the page family’s `--v2-selected` (C2, §9.29)', () => {
    const checked = /\.zen-search-choice-row\[aria-checked='true'\],\n[^{]*\{([^}]*)\}/.exec(css)
    expect(checked).not.toBeNull()
    expect(checked![1]).toContain('background: rgb(var(--zen-accent-rgb) / 0.12);')
    expect(css).not.toMatch(/zen-search-choice[^{]*\{[^}]*--v2-selected/)
  })
})
