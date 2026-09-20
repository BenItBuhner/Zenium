// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { FrameDialogHost, closeAllPopovers } from '@renderer/lib/portals'
import { viewportStore } from '@renderer/lib/formFactor'
import { FILE_SOURCE, IMPORT_READY } from '@renderer/lib/importData'
import { uiStore } from '@renderer/lib/ui'
import { ImportDialog } from '../ImportDialog'

/*
 * Chrome's "Import bookmarks and settings" on a mouse (ID-23's UI): the dialog probes the
 * sources as it opens and comes up on the first browser found with every kind checked, a
 * browser with two profiles gets the Profile menulist, a kind the source cannot give is a
 * disabled row whose second line is the recorded limit, a running Firefox is the refusal line
 * with Import off while a running Chrome is a notice with Import armed, Import asks `import.run`
 * for the source and the checked kinds and the form goes busy (read-only at full opacity, the
 * status line naming the kind being read), and the result takes the body – the headline, the
 * source, a row per kind, the limits as an inline note, Chrome's "Show bookmarks bar" box –
 * with Done dismissing the run and, when the box stayed checked, showing the bar.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function source(patch: Partial<ImportSource> & Pick<ImportSource, 'id' | 'browser'>): ImportSource {
  const names: Record<ImportSource['browser'], string> = {
    chrome: 'Google Chrome',
    chromium: 'Chromium',
    edge: 'Microsoft Edge',
    firefox: 'Firefox',
    safari: 'Safari',
    file: 'Bookmarks HTML file'
  }
  return {
    browserName: names[patch.browser],
    profileId: patch.id.split(':')[1] ?? '',
    name: names[patch.browser],
    path: '',
    running: false,
    kinds: ['bookmarks', 'history', 'passwords'],
    limits: {},
    ...patch
  }
}

const FIREFOX_LIMIT =
  'Firefox keeps its passwords in its own store. Export them as a CSV file in Firefox, then import the file.'

const CHROME_1 = source({ id: 'chrome:Default', browser: 'chrome', name: 'Person 1' })
const CHROME_2 = source({
  id: 'chrome:Profile 2',
  browser: 'chrome',
  name: 'Work',
  email: 'bennett@example.com'
})
const FIREFOX = source({
  id: 'firefox:abcd.default-release',
  browser: 'firefox',
  kinds: ['bookmarks', 'history'],
  limits: { passwords: FIREFOX_LIMIT }
})
const HTML = source({
  id: FILE_SOURCE.bookmarks,
  browser: 'file',
  name: 'Bookmarks HTML file',
  kinds: ['bookmarks']
})
const SOURCES = [CHROME_1, CHROME_2, FIREFOX, HTML]

function outcome(patch: Partial<ImportKindOutcome> = {}): ImportKindOutcome {
  return { imported: 0, duplicates: 0, unreadable: 0, invalid: 0, error: null, ...patch }
}

function progress(patch: Partial<ImportProgress> = {}): ImportProgress {
  return {
    source: CHROME_1,
    kinds: ['bookmarks', 'history', 'passwords'],
    status: 'done',
    current: null,
    results: {},
    error: null,
    folderId: null,
    startedAt: 1,
    finishedAt: 2,
    ...patch
  }
}

/** The dialog reads the running import and the bookmarks bar setting; nothing else of the state. */
function state(
  patch: Partial<UIState> = {},
  bookmarksBar = DEFAULT_SETTINGS.bookmarksBar
): UIState {
  return {
    platform: 'linux',
    import: null,
    settings: { ...DEFAULT_SETTINGS, bookmarksBar },
    ...patch
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

function rerender(el: ReactElement): void {
  act(() => root!.render(el))
}

function dialog(s: UIState = state()): ReactElement {
  return (
    <FrameDialogHost>
      <ImportDialog state={s} />
    </FrameDialogHost>
  )
}

/** Open the dialog and let the source probe answer. */
async function open(sources: ImportSource[] = SOURCES, s: UIState = state()): Promise<HTMLElement> {
  vi.mocked(cmd).mockImplementation(async (name: string) => {
    if (name === 'import.sources') return sources as never
    return null as never
  })
  uiStore.set({ importDialog: { source: null } })
  const el = render(dialog(s))
  await act(async () => {
    await Promise.resolve()
  })
  return el
}

function press(target: Element): void {
  act(() => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function menulists(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-haspopup="listbox"]'))
}

async function pick(trigger: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    press(trigger)
    await Promise.resolve()
  })
  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
  const option = options.find((o) => o.textContent?.trim() === label)
  if (!option) throw new Error(`no option "${label}" among ${options.map((o) => o.textContent)}`)
  press(option)
}

function kinds(): Array<{ kind: string; checked: boolean; disabled: boolean; text: string }> {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-import-kind]'))
    .filter((row) => row.closest('[data-testid="import-kinds"]'))
    .map((row) => {
      const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!
      return {
        kind: row.dataset.importKind!,
        checked: box.checked,
        disabled: box.disabled,
        text: row.textContent ?? ''
      }
    })
}

function submitButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('[data-testid="import-submit"]')!
}

function panel(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-testid="import-dialog"]')!
}

beforeEach(() => {
  act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false }))
})

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  uiStore.set({ importDialog: null })
  vi.mocked(cmd).mockReset()
  vi.mocked(cmd).mockImplementation(async () => null as never)
  vi.mocked(run).mockClear()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('the import dialog', () => {
  it('probes the sources as it opens, then comes up on the first browser with every kind checked', async () => {
    const before = vi.mocked(cmd).mock.calls.length
    uiStore.set({ importDialog: { source: null } })
    vi.mocked(cmd).mockImplementation(
      () => new Promise<never>(() => undefined) // the probe still running
    )
    render(dialog())
    expect(panel().dataset.phase).toBe('loading')
    expect(panel().textContent).toContain('Looking for other browsers on this computer…')
    expect(
      vi
        .mocked(cmd)
        .mock.calls.slice(before)
        .map((c) => c[0])
    ).toEqual(['import.sources'])
    act(() => root!.unmount())
    mount?.remove()

    await open()
    expect(panel().dataset.phase).toBe('form')
    // The 400 form width, the title in Chrome's words.
    expect(panel().style.width).toBe('400px')
    expect(panel().textContent).toContain('Import bookmarks and settings')
    const [from, profile] = menulists()
    expect(from!.textContent).toContain('Google Chrome')
    // Chrome has two profiles here: the Profile menulist tells them apart, the account beside.
    expect(profile!.textContent).toContain('Person 1')
    expect(kinds()).toEqual([
      { kind: 'bookmarks', checked: true, disabled: false, text: 'Bookmarks' },
      { kind: 'history', checked: true, disabled: false, text: 'Browsing history' },
      { kind: 'passwords', checked: true, disabled: false, text: 'Saved passwords' }
    ])
    expect(document.querySelector('[data-testid="import-running"]')).toBeNull()
    expect(submitButton().disabled).toBe(false)
  })

  it('switching to Firefox drops the Profile menulist and disables the passwords row with its recorded limit', async () => {
    await open()
    await pick(menulists()[0]!, 'Firefox')
    expect(menulists()).toHaveLength(1)
    const rows = kinds()
    expect(rows.map((r) => [r.kind, r.checked, r.disabled, r.text])).toEqual([
      ['bookmarks', true, false, 'Bookmarks'],
      ['history', true, false, 'Browsing history'],
      ['passwords', false, true, 'Saved passwords']
    ])
    // The recorded limit is the inline note under the rows at full ink – not a second line inside
    // the disabled row, where the check row's §9.30 .4 would leave it unreadable.
    const notes = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="import-limit"]'))
    expect(notes.map((n) => n.textContent)).toEqual([`Saved passwords: ${FIREFOX_LIMIT}`])
    expect(submitButton().disabled).toBe(false)
  })

  it('a running Firefox is the refusal line naming it, Import off; a running Chrome a notice with Import armed', async () => {
    await open([
      { ...CHROME_1, running: true },
      { ...FIREFOX, running: true }
    ])
    let line = document.querySelector<HTMLElement>('[data-testid="import-running"]')!
    expect(line.textContent).toBe(
      'Google Chrome is open. Zenium reads a copy of its data; if the import fails, close Google Chrome and try again.'
    )
    expect(line.className).toContain('--v2-warn')
    expect(submitButton().disabled).toBe(false)

    await pick(menulists()[0]!, 'Firefox')
    line = document.querySelector<HTMLElement>('[data-testid="import-running"]')!
    expect(line.textContent).toBe('Firefox is open. Close Firefox and try again.')
    expect(line.className).toContain('--v2-danger')
    expect(submitButton().disabled).toBe(true)
  })

  it('opens on the preselected source (the first-run offer’s pick, the pane’s file row)', async () => {
    vi.mocked(cmd).mockImplementation(async (name: string) =>
      name === 'import.sources' ? (SOURCES as never) : (null as never)
    )
    uiStore.set({ importDialog: { source: CHROME_2.id } })
    render(dialog())
    await act(async () => {
      await Promise.resolve()
    })
    expect(menulists()[1]!.textContent).toContain('Work')
    expect(panel().textContent).toContain('bennett@example.com')
    act(() => root!.unmount())
    mount?.remove()

    uiStore.set({ importDialog: { source: FILE_SOURCE.bookmarks } })
    render(dialog())
    await act(async () => {
      await Promise.resolve()
    })
    expect(menulists()).toHaveLength(1)
    expect(menulists()[0]!.textContent).toContain('Bookmarks HTML file')
    expect(kinds().map((r) => r.kind)).toEqual(['bookmarks'])
  })

  it('Import asks for the source and the checked kinds, goes busy, and shows the result Done dismisses', async () => {
    let finish: (p: ImportProgress) => void = () => undefined
    const running = new Promise<ImportProgress>((resolve) => {
      finish = resolve
    })
    vi.mocked(cmd).mockImplementation(async (name: string) => {
      if (name === 'import.sources') return SOURCES as never
      if (name === 'import.run') return running as never
      return null as never
    })
    uiStore.set({ importDialog: { source: null } })
    render(dialog())
    await act(async () => {
      await Promise.resolve()
    })

    // Unchecking history keeps the other two for the run.
    const history = document.querySelector<HTMLInputElement>('[data-import-kind="history"] input')!
    act(() => {
      history.click()
    })
    expect(kinds().map((r) => r.checked)).toEqual([true, false, true])

    press(submitButton())
    expect(vi.mocked(cmd)).toHaveBeenCalledWith('import.run', {
      source: CHROME_1.id,
      kinds: ['bookmarks', 'passwords']
    })
    // Busy from the press: the primary spins, Cancel is off, the fields are read-only in place.
    expect(panel().dataset.phase).toBe('busy')
    expect(submitButton().getAttribute('aria-busy')).toBe('true')
    const cancel = Array.from(panel().querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel'
    )!
    expect(cancel.disabled).toBe(true)
    const runningState = progress({
      status: 'running',
      kinds: ['bookmarks', 'passwords'],
      current: 'passwords',
      results: { bookmarks: outcome({ imported: 12 }) },
      finishedAt: null
    })
    rerender(dialog(state({ import: runningState })))
    expect(menulists()[0]!.getAttribute('aria-readonly')).toBe('true')
    expect(document.querySelector('[data-testid="import-kinds"]')!.getAttribute('aria-busy')).toBe(
      'true'
    )
    expect(document.querySelector('[data-testid="import-progress"]')!.textContent).toBe(
      'Importing saved passwords…'
    )
    // Escape does not leave a working import.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(uiStore.get().importDialog).not.toBeNull()

    const done = progress({
      kinds: ['bookmarks', 'passwords'],
      results: {
        bookmarks: outcome({ imported: 12, duplicates: 3 }),
        passwords: outcome({ imported: 4, unreadable: 2 })
      },
      folderId: 'folder-1'
    })
    finish(done)
    rerender(dialog(state({ import: done })))
    await act(async () => {
      await Promise.resolve()
    })
    expect(panel().dataset.phase).toBe('result')
    const result = document.querySelector<HTMLElement>('[data-testid="import-result"]')!
    expect(result.dataset.failed).toBeUndefined()
    expect(result.textContent).toContain(IMPORT_READY)
    expect(result.textContent).toContain('From Google Chrome (Person 1)')
    const rows = Array.from(result.querySelectorAll<HTMLElement>('li[data-import-kind]'))
    expect(rows.map((r) => r.dataset.importKind)).toEqual(['bookmarks', 'passwords'])
    expect(rows[0]!.textContent).toContain('12 bookmarks imported')
    expect(rows[0]!.textContent).toContain('3 already saved')
    expect(rows[1]!.textContent).toContain('4 passwords imported')
    expect(rows[1]!.textContent).toContain('2 could not be opened')
    // The headline takes the focus so the outcome is read.
    expect(document.activeElement?.textContent).toBe(IMPORT_READY)
    // Bookmarks came in and the bar is not always shown: Chrome's box, checked.
    const bar = document.querySelector<HTMLElement>('[data-testid="import-show-bar"] input')!
    expect((bar as HTMLInputElement).checked).toBe(true)
    // A folder was made: Show bookmarks beside Done.
    expect(document.querySelector('[data-testid="import-show-bookmarks"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="import-again"]')).toBeNull()

    press(document.querySelector('[data-testid="import-done"]')!)
    expect(vi.mocked(run)).toHaveBeenCalledWith('settings.update', { bookmarksBar: 'always' })
    expect(vi.mocked(run)).toHaveBeenCalledWith('import.dismiss', undefined)
    // The chassis closes on its spring; the store flag clears as the motion ends.
    await vi.waitFor(() => expect(uiStore.get().importDialog).toBeNull())
  })

  it('a failed run is the failure as headline, the limits as a note, Try again back to the form', async () => {
    const failed = progress({
      source: FIREFOX,
      kinds: ['bookmarks', 'history'],
      status: 'failed',
      error: 'Firefox is open. Close Firefox and try again.',
      results: {}
    })
    vi.mocked(cmd).mockImplementation(async (name: string) => {
      if (name === 'import.sources') return SOURCES as never
      if (name === 'import.run') return failed as never
      return null as never
    })
    uiStore.set({ importDialog: { source: FIREFOX.id } })
    render(dialog())
    await act(async () => {
      await Promise.resolve()
    })
    press(submitButton())
    rerender(dialog(state({ import: failed })))
    await act(async () => {
      await Promise.resolve()
    })
    const result = document.querySelector<HTMLElement>('[data-testid="import-result"]')!
    expect(result.dataset.failed).toBe('true')
    expect(result.textContent).toContain('Firefox is open. Close Firefox and try again.')
    expect(result.textContent).toContain('From Firefox')
    // The kind the source cannot give is the inline note under the (empty) rows.
    const note = document.querySelector<HTMLElement>('[data-testid="import-limit"]')!
    expect(note.textContent).toBe(`Saved passwords: ${FIREFOX_LIMIT}`)
    // No bookmarks came in: no bar box, no Show bookmarks.
    expect(document.querySelector('[data-testid="import-show-bar"]')).toBeNull()
    expect(document.querySelector('[data-testid="import-show-bookmarks"]')).toBeNull()

    vi.mocked(run).mockClear()
    press(document.querySelector('[data-testid="import-again"]')!)
    expect(vi.mocked(run)).toHaveBeenCalledWith('import.dismiss', undefined)
    rerender(dialog(state({ import: null })))
    await act(async () => {
      await Promise.resolve()
    })
    expect(panel().dataset.phase).toBe('form')
    expect(menulists()[0]!.textContent).toContain('Firefox')
  })

  it('a finished import left from before is dismissed as the dialog opens, and Cancel leaves the form', async () => {
    const stale = progress({ results: { bookmarks: outcome({ imported: 2 }) } })
    await open(SOURCES, state({ import: stale }))
    expect(vi.mocked(run)).toHaveBeenCalledWith('import.dismiss', undefined)
    // Not this dialog's run: the form, not a result.
    expect(panel().dataset.phase).toBe('form')
    const cancel = Array.from(panel().querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel'
    )!
    press(cancel)
    await vi.waitFor(() => expect(uiStore.get().importDialog).toBeNull())
  })
})
