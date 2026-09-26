// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SearchChoiceState, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import { shuffledSearchChoiceTiles } from '@core/searchChoice'

/*
 * The EEA's search-engine choice screen as the phone draws it (OMN-26; `PhoneOnboarding.tsx`,
 * `PhoneSearchChoice.tsx`) on #514's model and terms: the tour's search step is the choice
 * screen in the EEA – the region's list in the run's order, nothing picked, "Set as default"
 * live once a tile is picked, "Skip for now" recording nothing – and the same list stands on its
 * own over the shell while the screen is owed, where the system back gesture is taken and keeps
 * it. Outside the EEA the tour's step keeps its plain tiles and its Continue.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PhoneOnboarding } = await import('../PhoneOnboarding')
const { PhoneSearchChoiceScreen } = await import('../PhoneSearchChoice')
const { browserStore } = await import('@renderer/lib/ui')
const { dispatchBackEvent, topBackSurface } = await import('@renderer/lib/back')
const { searchChoiceCovers } = await import('@renderer/lib/searchChoice')

const SEED = 0x5eed
const EEA: SearchChoiceState = { region: 'DE', eea: true, required: true, seed: SEED }
const ELSEWHERE: SearchChoiceState = { region: 'US', eea: false, required: false, seed: SEED }
const ANSWERED: SearchChoiceState = { region: 'DE', eea: true, required: false, seed: SEED }

/** The phone's state with the choice screen's terms; no browser role to give, so the search step is the tour's last. */
function phone(onboardingDone: boolean, searchChoice: SearchChoiceState): UIState {
  return {
    platform: 'android',
    capabilities: {},
    defaultBrowser: { isDefault: null, prompt: null },
    tabs: {},
    spaces: [{ id: 'space', activeTabId: null, tabIds: [], theme: null }],
    activeSpaceId: 'space',
    essentialTabIds: [],
    folders: {},
    settings: { ...DEFAULT_SETTINGS, onboardingDone, searchEngineId: 'google' },
    searchEngines: DEFAULT_SEARCH_ENGINES,
    searchChoice,
    shortcuts: [],
    systemDark: false,
    window: { kind: 'synced', chrome: 'full', fullscreen: false, htmlFullscreenTabId: null }
  } as unknown as UIState
}

/** What `PhoneShell` mounts of the two, on its terms. */
function Shell(): JSX.Element | null {
  const state = browserStore.use((s) => s.state)
  if (!state) return null
  const tour = !state.settings.onboardingDone
  return createElement(
    'div',
    null,
    tour && createElement(PhoneOnboarding, { state }),
    !tour && searchChoiceCovers(state) && createElement(PhoneSearchChoiceScreen, { state })
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

const commands = (): Array<[string, unknown]> =>
  invoke.mock.calls.map(([name, args]) => [name, args])
const q = <T extends Element>(selector: string): T | null => document.querySelector<T>(selector)
const rows = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('[role="radio"].zen-firstrun-choice')
]
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)
const setDefault = (): HTMLButtonElement =>
  q<HTMLButtonElement>('[data-testid="search-choice-set"]')!
const skipForNow = (): HTMLButtonElement =>
  q<HTMLButtonElement>('[data-testid="search-choice-skip"]')!

async function click(b: HTMLButtonElement | undefined): Promise<void> {
  if (!b) throw new Error('no such button')
  await act(async () => {
    b.focus()
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

/** Through the tour's welcome and look to the search step. */
async function toSearchStep(): Promise<void> {
  await click(button('Get started'))
  await click(button('Continue'))
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  browserStore.set({ state: null })
  invoke.mockClear()
})

describe('the phone tour’s search step in the EEA', () => {
  it('is the choice screen: the run’s order, every tile named, nothing picked, Set as default off, no Continue', async () => {
    await mount(phone(false, EEA))
    await toSearchStep()

    expect(q('[data-testid="search-choice"]')).not.toBeNull()
    expect(q('h2')?.textContent).toBe('Choose your search engine')
    const group = q<HTMLElement>('[role="radiogroup"]')!
    expect(group.getAttribute('aria-labelledby')).toBe(q('h2')!.id)
    expect(group.getAttribute('aria-required')).toBe('true')
    // Germany's list in the run's order, from the state's seed – the order the desktop shows.
    const expected = shuffledSearchChoiceTiles('DE', SEED)
    expect(rows()).toHaveLength(8)
    expect(rows().map((r) => r.dataset.engine)).toEqual(expected.map((t) => t.engine.id))
    rows().forEach((r, i) => {
      const tile = expected[i]!
      expect(r.getAttribute('aria-checked')).toBe('false')
      // The accessible name is the engine's; its line describes it (harness contracts).
      expect(r.getAttribute('aria-label')).toBe(tile.engine.name)
      const line = document.getElementById(r.getAttribute('aria-describedby')!)
      expect(line?.textContent).toBe(tile.tagline)
      expect(r.querySelector('.zen-firstrun-choice-name')?.textContent).toBe(tile.engine.name)
      const icon = r.querySelector<HTMLImageElement>('.zen-firstrun-choice-mark > img')
      expect(icon, tile.engine.id).not.toBeNull()
      expect(icon!.getAttribute('src')).toMatch(/search-engines\/[a-z]+\.png/)
    })
    expect(setDefault().disabled).toBe(true)
    expect(setDefault().textContent).toBe('Set as default')
    expect(skipForNow().textContent).toBe('Skip for now')
    expect(button('Continue')).toBeUndefined()
    expect(button('Start browsing')).toBeUndefined()
    expect(commands().map(([n]) => n)).not.toContain('searchChoice.choose')
  })

  it('a pick lights Set as default; Set tells the core and the tour ends on the pick', async () => {
    await mount(phone(false, EEA))
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
    // The search step is this tour's last: the tour completes on the chosen engine.
    expect(commands()).toContainEqual([
      'onboarding.complete',
      { searchEngineId: 'bing', colorScheme: 'system', essentials: [] }
    ])
  })

  it('Skip for now records nothing and the tour goes on with the shipped default', async () => {
    await mount(phone(false, EEA))
    await toSearchStep()

    await click(skipForNow())
    expect(commands()).toContainEqual(['searchChoice.skip', undefined])
    expect(commands().map(([n]) => n)).not.toContain('searchChoice.choose')
    expect(commands()).toContainEqual([
      'onboarding.complete',
      { searchEngineId: 'google', colorScheme: 'system', essentials: [] }
    ])
  })

  it('keeps the choice form when the core answers mid-tour – the step is settled when the tour mounts', async () => {
    await mount(phone(false, EEA))
    await toSearchStep()
    await click(rows().find((r) => r.dataset.engine === 'ecosia'))
    // The core answers: the choice is no longer owed. The step must not turn into the plain tiles
    // under the user's finger.
    await act(async () => browserStore.set({ state: phone(false, ANSWERED) }))
    expect(q('[data-testid="search-choice"]')).not.toBeNull()
    const checked = rows().filter((r) => r.getAttribute('aria-checked') === 'true')
    expect(checked.map((r) => r.dataset.engine)).toEqual(['ecosia'])
    expect(setDefault().disabled).toBe(false)
  })

  it('outside the EEA the step keeps its plain tiles and its Continue', async () => {
    await mount(phone(false, ELSEWHERE))
    await toSearchStep()

    expect(q('[data-testid="search-choice"]')).toBeNull()
    expect(rows()).toHaveLength(0)
    expect(q('[data-testid="search-choice-set"]')).toBeNull()
    expect(button('Skip for now')).toBeUndefined()
    // This tour's last step: the one primary carries on.
    expect(button('Start browsing')).not.toBeUndefined()
  })
})

describe('the choice screen on its own over the phone shell', () => {
  it('stands while the choice is owed after the tour, and answers the core', async () => {
    await mount(phone(true, EEA))

    const screen = q<HTMLElement>('[data-testid="search-choice-screen"]')!
    expect(screen).not.toBeNull()
    expect(screen.getAttribute('role')).toBe('dialog')
    expect(screen.getAttribute('aria-modal')).toBe('true')
    expect(screen.getAttribute('aria-labelledby')).toBe(q('h2')!.id)
    expect(screen.dataset.surface).toBe('window')
    expect(document.activeElement).toBe(screen)
    expect(rows()).toHaveLength(8)
    expect(setDefault().disabled).toBe(true)

    await click(rows().find((r) => r.dataset.engine === 'qwant'))
    await click(setDefault())
    expect(commands()).toContainEqual(['searchChoice.choose', { engineId: 'qwant' }])

    // The core's answer takes the screen down; nothing is kept here.
    await act(async () => browserStore.set({ state: phone(true, ANSWERED) }))
    expect(q('[data-testid="search-choice-screen"]')).toBeNull()
  })

  it('Skip for now records nothing; the screen stays until the core says the choice is not owed', async () => {
    await mount(phone(true, EEA))
    await click(skipForNow())
    expect(commands()).toEqual([['searchChoice.skip', undefined]])
    expect(q('[data-testid="search-choice-screen"]')).not.toBeNull()
  })

  it('takes the system back gesture and keeps the screen', async () => {
    await mount(phone(true, EEA))
    expect(topBackSurface()?.name).toBe('search-choice')
    // A gesture, and the back button's plain commit: both are the screen's, and neither closes it.
    expect(dispatchBackEvent('start', { edge: 'left' })).toBe(true)
    expect(dispatchBackEvent('progress', { progress: 0.8 })).toBe(true)
    expect(dispatchBackEvent('commit')).toBe(true)
    expect(dispatchBackEvent('commit')).toBe(true)
    expect(q('[data-testid="search-choice-screen"]')).not.toBeNull()
    expect(commands()).toEqual([])
  })

  it('is not mounted once the choice is answered, nor outside the EEA', async () => {
    await mount(phone(true, ANSWERED))
    expect(q('[data-testid="search-choice-screen"]')).toBeNull()
    await act(async () => browserStore.set({ state: phone(true, ELSEWHERE) }))
    expect(q('[data-testid="search-choice-screen"]')).toBeNull()
    expect(topBackSurface()).toBeNull()
  })
})
