// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ImportKindOutcome, ImportProgress, ImportSource, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { cmd, run } from '@renderer/lib/api'
import { ImportSection } from '../ImportSection'

/*
 * Settings > Import's Last import row on a mouse (#259's lead verdict, §9.33): the row stands
 * alone in a pane whose every other label sits on the one text edge, so its status glyph
 * TRAILS – before Dismiss – rather than leading and indenting its one label past its
 * neighbours (a status glyph leads only where every row of the list carries one, the Safety
 * Check rows). The glyph and the label share the §1 status ink on a failure; an empty run takes
 * the aside glyph; the row draws nothing in its leading slot.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CHROMIUM: ImportSource = {
  id: 'chromium:Profile 1',
  browser: 'chromium',
  browserName: 'Chromium',
  profileId: 'Profile 1',
  name: 'Work',
  path: '',
  running: false,
  kinds: ['bookmarks', 'history', 'passwords'],
  limits: {}
}

function outcome(patch: Partial<ImportKindOutcome> = {}): ImportKindOutcome {
  return { imported: 0, duplicates: 0, unreadable: 0, invalid: 0, error: null, ...patch }
}

function progress(patch: Partial<ImportProgress> = {}): ImportProgress {
  return {
    source: CHROMIUM,
    kinds: ['bookmarks', 'passwords'],
    status: 'done',
    current: null,
    results: {
      bookmarks: outcome({ imported: 1 }),
      passwords: outcome({ imported: 1 })
    },
    error: null,
    folderId: null,
    startedAt: 1,
    finishedAt: 2,
    ...patch
  }
}

/** The pane reads the finished import and the active tab; nothing else of the state. */
function state(last: ImportProgress | null): UIState {
  return {
    platform: 'linux',
    import: last,
    tabs: [],
    activeTabId: null,
    settings: { ...DEFAULT_SETTINGS }
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

async function render(el: ReactElement): Promise<HTMLElement> {
  vi.mocked(cmd).mockImplementation(async (name: string) => {
    if (name === 'import.sources') return [CHROMIUM] as never
    return null as never
  })
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  await act(async () => {
    await Promise.resolve()
  })
  return mount
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  vi.mocked(run).mockReset()
})

function lastRow(el: HTMLElement): HTMLElement {
  const row = el.querySelector<HTMLElement>('[data-testid="import-last"]')
  if (!row) throw new Error('no Last import row')
  return row
}

describe('the pane’s Last import row', () => {
  it('trails its status glyph before Dismiss and draws nothing leading, so its label sits on the pane’s one text edge (§9.33, §10.3)', async () => {
    const el = await render(<ImportSection state={state(progress())} />)
    const row = lastRow(el)
    const children = Array.from(row.children)
    // The row's children are the text block and the trailing slot – no leading span before the text.
    expect(children).toHaveLength(2)
    const [text, trailing] = children as HTMLElement[]
    expect(text.textContent).toContain('Your bookmarks and settings are ready')
    expect(text.textContent).toContain(
      'From Chromium (Work) · 1 bookmark imported · 1 password imported'
    )
    expect(text.querySelector('svg')).toBeNull()
    // The trailing slot: the glyph first, Dismiss after it.
    const glyph = trailing.querySelector('svg')
    expect(glyph).not.toBeNull()
    expect(glyph?.classList.contains('lucide-circle-check')).toBe(true)
    const dismiss = trailing.querySelector<HTMLButtonElement>('[data-testid="import-dismiss-last"]')
    expect(dismiss?.textContent).toBe('Dismiss')
    expect(glyph!.compareDocumentPosition(dismiss!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The whole row is one static row (a control of its own, not a target).
    expect(row.hasAttribute('data-static')).toBe(true)
  })

  it('a failed run is the danger ink on label and glyph alike, the glyph still trailing', async () => {
    const failed = progress({
      status: 'failed',
      error: 'Chromium is open. Close Chromium and try again.',
      results: {}
    })
    const el = await render(<ImportSection state={state(failed)} />)
    const row = lastRow(el)
    const label = row.querySelector<HTMLElement>('.truncate')
    expect(label?.textContent).toBe('Chromium is open. Close Chromium and try again.')
    expect(label?.className).toContain('text-[var(--v2-danger)]')
    const glyph = row.querySelector('svg')
    expect(glyph?.classList.contains('lucide-circle-alert')).toBe(true)
    expect(glyph?.getAttribute('class')).toContain('text-[var(--v2-danger)]')
    expect(row.children[0]!.querySelector('svg')).toBeNull()
  })

  it('Dismiss asks the engine to drop the finished import', async () => {
    const el = await render(<ImportSection state={state(progress())} />)
    act(() => {
      lastRow(el).querySelector<HTMLButtonElement>('[data-testid="import-dismiss-last"]')!.click()
    })
    expect(run).toHaveBeenCalledWith('import.dismiss', undefined)
  })

  it('draws no Last import group without a finished import', async () => {
    const el = await render(<ImportSection state={state(null)} />)
    expect(el.querySelector('[data-testid="import-last"]')).toBeNull()
  })
})
