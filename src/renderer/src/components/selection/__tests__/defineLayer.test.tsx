// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DefineLookup, DefineResult, UIState } from '@shared/types'
import { browserStore, uiStore } from '@renderer/lib/ui'

/*
 * The Define surface (CT-39; Edge's mini menu's Define) on the desktop: a popover of the
 * selection surfaces' chassis over the selection, headed with the term, that looks the term up
 * through the core (`define.lookup`) and shows up to three senses under their parts of speech
 * with Wiktionary's attribution and the See more button; a refusal in one sentence; Escape,
 * another chrome surface, the tab's going or another tab coming to the front close it. The
 * strings here are the lead's to check (the PR's `## LEAD CHECK`).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
const cmd = vi.fn<(name: string, args: unknown) => Promise<unknown>>()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: (name: string, args: unknown) => cmd(name, args),
  onEvent: () => () => undefined
}))
// The page's capture behind the popover is in place at once.
vi.mock('@renderer/hooks/useFloatingChrome', () => ({ useFloatingChrome: () => true }))

const { DefineLayer } = await import('../DefinePopover')
const { closeDefine, defineRefusalMessage, openDefine, senses } =
  await import('@renderer/lib/define')
const { openTranslateSelection } = await import('@renderer/lib/translate')

const RESULT: DefineResult = {
  term: 'quantum foam',
  lang: 'en',
  entries: [
    {
      partOfSpeech: 'Noun',
      language: 'English',
      definitions: [
        { text: 'The fluctuating fabric of spacetime at the smallest scales.', examples: [] },
        { text: 'A frothy state of a field.', examples: ['The foam seethed.'] }
      ]
    },
    {
      partOfSpeech: 'Verb',
      language: 'English',
      definitions: [
        { text: 'To seethe at the Planck scale.', examples: [] },
        { text: 'A fourth sense the surface never shows.', examples: [] }
      ]
    }
  ],
  attribution: {
    source: 'Wiktionary',
    licence: 'CC BY-SA 4.0',
    url: 'https://en.wiktionary.org/wiki/quantum_foam'
  }
}

const RECT = { x: 100, y: 200, width: 120, height: 18 }

function state(activeTabId = 't1'): UIState {
  return {
    platform: 'linux',
    tabs: {
      t1: { id: 't1', zoom: 1, url: 'https://example.com/', title: 'Example' },
      t2: { id: 't2', zoom: 1, url: 'https://example.org/', title: 'Other' }
    },
    spaces: [{ id: 's1', activeTabId, tabIds: ['t1', 't2'] }],
    activeSpaceId: 's1',
    essentialTabIds: [],
    folders: {},
    settings: {},
    capabilities: { selectionMenu: true },
    autofill: { prompts: [], picker: null },
    selectionMenu: null,
    window: { kind: 'normal', fullscreen: false }
  } as unknown as UIState
}

let container: HTMLDivElement
let root: Root
let answer: (lookup: DefineLookup) => void = () => undefined
let fail: (error: unknown) => void = () => undefined

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]')
const text = (selector: string): string[] =>
  [...document.querySelectorAll<HTMLElement>(selector)].map((el) => el.textContent ?? '')
const button = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('.zen-translate-footer button')

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function open(term = 'quantum foam', rect: typeof RECT | null = RECT): Promise<void> {
  act(() => openDefine({ tabId: 't1', term, rect }))
  await settle()
}

async function resolve(lookup: DefineLookup): Promise<void> {
  await act(async () => {
    answer(lookup)
    await Promise.resolve()
  })
}

beforeEach(() => {
  run.mockClear()
  cmd.mockReset()
  cmd.mockImplementation(
    () =>
      new Promise((res, rej) => {
        answer = res as (lookup: DefineLookup) => void
        fail = rej
      })
  )
  browserStore.set({ state: state() })
  uiStore.set({ define: null, translateSelection: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<DefineLayer />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  uiStore.set({ define: null, translateSelection: null })
  document.querySelectorAll('.zen-chrome-layer').forEach((el) => el.remove())
})

describe('the Define popover', () => {
  it('opens for the core’s request, headed with the term, and asks the core for the definition', async () => {
    expect(dialog()).toBeNull()
    await open()
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    const panel = dialog()!
    expect(panel).not.toBeNull()
    expect(panel.classList.contains('zen-translate-panel')).toBe(true)
    expect(text('.zen-v2-title-block-title')).toEqual(['quantum foam'])
    expect(panel.querySelector('.zen-v2-title-block-title svg')).not.toBeNull()
    expect(text('.zen-define-result')).toEqual(['Looking up “quantum foam”…'])
    expect(cmd).toHaveBeenCalledWith('define.lookup', { term: 'quantum foam' })
    expect(button()!.textContent).toBe('See more on Wiktionary')
    expect(button()!.disabled).toBe(true)
  })

  it('shows up to three senses under their parts of speech, the attribution, and See more opens the page', async () => {
    await open()
    await resolve({ ok: true, result: RESULT })
    expect(text('.zen-define-pos')).toEqual(['Noun', 'Verb'])
    expect(text('.zen-define-senses li')).toEqual([
      'The fluctuating fabric of spacetime at the smallest scales.',
      'A frothy state of a field.',
      'To seethe at the Planck scale.'
    ])
    expect(text('.zen-define-attribution')).toEqual(['From Wiktionary, CC BY-SA 4.0'])
    expect(dialog()!.querySelector('.zen-translate-rule')).not.toBeNull()
    const more = button()!
    expect(more.disabled).toBe(false)
    act(() => {
      more.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(run).toHaveBeenCalledWith('tab.create', {
      url: 'https://en.wiktionary.org/wiki/quantum_foam',
      active: true
    })
  })

  it('says in one sentence why there is no definition, and See more stays off', async () => {
    await open()
    await resolve({ ok: false, reason: 'not-found' })
    expect(text('.zen-define-result')).toEqual(['No definition found for “quantum foam”.'])
    expect(dialog()!.querySelector('.zen-translate-danger')).not.toBeNull()
    expect(dialog()!.querySelector('.zen-define-attribution')).toBeNull()
    expect(button()!.disabled).toBe(true)
  })

  it('reads a failed command without the host’s wrapping', async () => {
    await open()
    await act(async () => {
      fail(new Error("Error invoking remote method 'define.lookup': Error: The lookup broke"))
      await Promise.resolve()
    })
    expect(text('.zen-define-result')).toEqual(['The lookup broke'])
  })

  it('closes on Escape, and when the tab goes or another comes to the front', async () => {
    await open()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(uiStore.get().define).toBeNull()
    expect(dialog()).toBeNull()

    await open()
    act(() => browserStore.set({ state: state('t2') }))
    expect(uiStore.get().define).toBeNull()

    await open()
    const gone = state()
    delete (gone.tabs as Record<string, unknown>)['t1']
    act(() => browserStore.set({ state: gone }))
    expect(uiStore.get().define).toBeNull()
  })

  it('gives way to another chrome surface, and takes the translation popover’s place', async () => {
    await open()
    act(() => uiStore.set({ urlbar: { ...uiStore.get().urlbar, open: true } }))
    expect(uiStore.get().define).toBeNull()
    act(() => uiStore.set({ urlbar: { ...uiStore.get().urlbar, open: false } }))

    await open()
    act(() => openTranslateSelection({ tabId: 't1', text: 'quantum foam', x: 1, y: 2 }))
    expect(uiStore.get().define).toBeNull()
    expect(uiStore.get().translateSelection).not.toBeNull()

    await open()
    expect(uiStore.get().translateSelection).toBeNull()
    expect(uiStore.get().define).not.toBeNull()
    act(() => closeDefine())
  })

  it('anchors nothing when the request has no box (the phone’s toolbar) and still opens', async () => {
    await open('foam', null)
    expect(dialog()).not.toBeNull()
    expect(text('.zen-v2-title-block-title')).toEqual(['foam'])
  })
})

describe('the senses shown', () => {
  it('take the first three across the entries and skip empty text', () => {
    expect(senses(RESULT).map((p) => [p.partOfSpeech, p.definitions.length])).toEqual([
      ['Noun', 2],
      ['Verb', 1]
    ])
    const sparse: DefineResult = {
      ...RESULT,
      entries: [
        {
          partOfSpeech: 'Adjective',
          language: 'English',
          definitions: [{ text: ' ', examples: [] }]
        },
        ...RESULT.entries
      ]
    }
    expect(senses(sparse).map((p) => p.partOfSpeech)).toEqual(['Noun', 'Verb'])
    expect(senses(RESULT, 1)).toEqual([
      { partOfSpeech: 'Noun', definitions: [RESULT.entries[0].definitions[0]] }
    ])
  })
})

describe('the refusals', () => {
  it('are one sentence of the thing, uncontracted, with a full stop; not-found names the term', () => {
    expect(defineRefusalMessage('invalid-term', 'x')).toBe(
      'Only a word or a short phrase can be defined.'
    )
    expect(defineRefusalMessage('not-found', 'quantum foam')).toBe(
      'No definition found for “quantum foam”.'
    )
    expect(defineRefusalMessage('offline', 'x')).toBe('Wiktionary could not be reached.')
    expect(defineRefusalMessage('unavailable', 'x')).toBe('Wiktionary did not answer.')
    expect(defineRefusalMessage('malformed', 'x')).toBe('Wiktionary’s answer could not be read.')
  })
})
