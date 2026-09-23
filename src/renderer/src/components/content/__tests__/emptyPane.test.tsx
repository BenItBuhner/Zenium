// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState } from '@shared/types'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'

/*
 * The empty pane's "Choose a tab" (split-04) is the tab picker's anchor (design language v2
 * §9.20, §9.22): it says what it opens (`aria-haspopup="dialog"`) and whether that is up
 * (`aria-expanded`) – the pair every popover anchor carries. The picker's request names the pane
 * it hangs from (`openTabPicker`'s `pick.paneTabId`), so the pane reads its state from the UI
 * store it is given and needs no plumbing of its own; another pane's picker leaves it closed.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  run: vi.fn(),
  cmd: vi.fn(),
  onEvent: () => () => undefined
}))

const { EmptyPane } = await import('../EmptyPane')
const { uiStore } = await import('@renderer/lib/ui')

const state = {
  settings: { urlbarBehavior: 'normal', searchEngineId: DEFAULT_SEARCH_ENGINES[0]!.id },
  searchEngines: DEFAULT_SEARCH_ENGINES,
  searchEngineControl: null
} as unknown as UIState
const rect = { x: 0, y: 0, width: 600, height: 500 }
const viewport = { x: 300, y: 80, width: 1200, height: 900 }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(tabSearch: ReturnType<typeof uiStore.get>['tabSearch']): HTMLButtonElement {
  const ui = { ...uiStore.get(), tabSearch }
  act(() =>
    root.render(
      <EmptyPane state={state} ui={ui} tabId="blank" groupId="g" rect={rect} viewport={viewport} />
    )
  )
  return container.querySelector<HTMLButtonElement>('[data-pick-tab="blank"]')!
}

describe('the empty pane’s Choose a tab as the picker’s anchor (§9.20, §9.22)', () => {
  it('says aria-haspopup=dialog and aria-expanded=false with no picker up', () => {
    const button = render(null)
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.classList.contains('zen-v2-button')).toBe(true)
  })

  it('is expanded while the picker hangs from this pane, and not while it hangs from another', () => {
    const pick = {
      paneTabId: 'blank',
      groupId: 'g',
      pane: { x: 300, y: 80, width: 600, height: 500 }
    }
    expect(render({ keyboard: true, pick }).getAttribute('aria-expanded')).toBe('true')
    const other = { ...pick, paneTabId: 'other-blank' }
    expect(render({ keyboard: true, pick: other }).getAttribute('aria-expanded')).toBe('false')
    // Ctrl+Shift+A's search, no pick: not this pane's popover.
    expect(render({ keyboard: false }).getAttribute('aria-expanded')).toBe('false')
  })
})
