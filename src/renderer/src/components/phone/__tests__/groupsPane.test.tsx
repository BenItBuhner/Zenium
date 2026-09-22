// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Tab } from '@shared/types'
import { FOLDER_COLORS } from '@shared/defaults'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { groupRows, type GroupRow } from '@renderer/lib/groupRows'
import { FrameDialogHost } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'
import { DeleteGroupSheet, GroupRowSheet, GroupsPane } from '../GroupsPane'

/*
 * The overview's Groups pane rendered for real (TAB-16; Chrome for Android's "Tab groups" pane;
 * design language v2 §9.2, §9.13, §9.23, §9.29, §9.30, §10.3): the space's groups as the phone
 * panels' 64 two-line rows under OPEN and SAVED headings with their counts, a saved group –
 * its tabs closed, its pages kept – listed with the ring glyph and the pages it keeps, the most
 * recently used first; the empty group at the one disabled number with its hold kept; the row's
 * tap, hold and trailing button; the name being edited in the row's title slot; the pane at
 * none. Then the row's sheet by the group's state – Close Group in the plain ink, Delete Group
 * alone in the danger ink (§6) – with the colour swatches, and Delete Group's §9.23 prompt.
 */

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

/** The text of the first `selector {` rule in the stylesheet. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = 1_700_000_000_000
const MINUTE = 60_000

function folder(id: string, over: Partial<Folder> = {}): Folder {
  return {
    id,
    spaceId: 'space',
    name: id[0].toUpperCase() + id.slice(1),
    icon: '📁',
    collapsed: false,
    color: 'blue',
    ...over
  } as Folder
}

function tab(id: string, folderId: string, lastActiveAt = 0): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: 'default',
    url: `https://${id}.example/`,
    title: id,
    folderId,
    pinned: false,
    essential: false,
    lastActiveAt
  } as unknown as Tab
}

/**
 * The pane's rows for `folders`, their live members being the `tabs` that name them – the
 * private ones (`containerId: 'private'`) fed as the Private pane's, the way `TabOverview` does.
 */
function rowsOf(folders: Folder[], tabs: Tab[] = []): ReturnType<typeof groupRows> {
  const isPrivate = (t: Tab): boolean => t.containerId === 'private'
  return groupRows(
    folders,
    (folderId) => tabs.filter((t) => t.folderId === folderId && !isPrivate(t)),
    (folderId) => tabs.filter((t) => t.folderId === folderId && isPrivate(t))
  )
}

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

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const all = (selector: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(selector)
]
const texts = (selector: string): string[] =>
  all(selector).map((el) => el.textContent?.trim() ?? '')

// The sheets' springs run on the animation frame: the frames are stepped by hand.
const frames = new Map<number, (t: number) => void>()
let nextFrame = 1
let now = NOW

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    const id = nextFrame++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  uiStore.set({ renamingFolderId: null })
  vi.mocked(run).mockClear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Frames and timers pass until every spring in flight has landed. */
const settle = (): void => {
  act(() => {
    for (let i = 0; i < 600 && frames.size; i++) {
      now += 16
      vi.advanceTimersByTime(16)
      const batch = [...frames.values()]
      frames.clear()
      for (const cb of batch) cb(now)
    }
    vi.runOnlyPendingTimers()
  })
}

/** Type into a controlled field: the native setter, so React's value tracker sees the change. */
function type(field: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const noop = (): void => undefined

interface Picks {
  opened: GroupRow[]
  menus: GroupRow[]
}

function pane(
  folders: Folder[],
  tabs: Tab[] = [],
  renamingId: string | null = null
): Picks & { rows: ReturnType<typeof groupRows> } {
  const rows = rowsOf(folders, tabs)
  const picks: Picks = { opened: [], menus: [] }
  render(
    <GroupsPane
      rows={rows}
      renamingId={renamingId}
      onOpen={(row) => picks.opened.push(row)}
      onMenu={(row) => picks.menus.push(row)}
    />
  )
  return { ...picks, rows }
}

const rowNamed = (name: string): HTMLElement =>
  all('.zen-phone-row').find((el) => el.querySelector('.zen-list-title')?.textContent === name)!

describe('the Groups pane (TAB-16)', () => {
  it('lists the open groups in the grid’s order under Open, then the saved ones by their last use, each heading counting', () => {
    const work = folder('work', { lastUsedAt: NOW - 5 * MINUTE })
    const trip = folder('trip', {
      color: 'green',
      lastUsedAt: NOW - 2 * 60 * MINUTE,
      savedTabs: [{ url: 'https://t1.example/', title: 't1' }]
    })
    const reading = folder('reading', {
      color: 'red',
      lastUsedAt: NOW - 10 * MINUTE,
      savedTabs: [
        { url: 'https://r1.example/', title: 'r1' },
        { url: 'https://r2.example/', title: 'r2' },
        { url: 'https://r3.example/', title: 'r3' }
      ]
    })
    const later = folder('later')
    pane([trip, work, later, reading], [tab('w1', 'work'), tab('w2', 'work')])

    expect(q('[data-testid="overview-groups"]')).not.toBeNull()
    expect(texts('.zen-v2-heading > span:first-child')).toEqual(['Open', 'Saved'])
    expect(texts('.zen-overview-groups-aside')).toEqual(['2', '2'])
    // Open in the grid's order (Work, then the empty Later); saved with the last used first.
    expect(texts('[data-testid="overview-groups-open"] .zen-list-title')).toEqual(['Work', 'Later'])
    expect(texts('[data-testid="overview-groups-saved"] .zen-list-title')).toEqual([
      'Reading',
      'Trip'
    ])
    expect(texts('[data-testid="overview-groups-open"] .zen-list-subtitle')).toEqual([
      '2 tabs · 5 min ago',
      'No tabs'
    ])
    expect(texts('[data-testid="overview-groups-saved"] .zen-list-subtitle')).toEqual([
      '3 tabs · 10 min ago',
      '1 tab · 2 h ago'
    ])
    // Two-line rows with the group's sentence for TalkBack, the state a card never has.
    for (const row of all('.zen-phone-row')) expect(row.dataset.twoLine).toBe('true')
    expect(rowNamed('Work').querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(
      'Work, tab group, 2 tabs'
    )
    expect(rowNamed('Reading').querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(
      'Reading, tab group, 3 tabs, saved'
    )
    expect(rowNamed('Later').querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(
      'Later, tab group, no tabs'
    )
  })

  it('keeps a group that private tabs alone fill off the pane – the Private pane’s – and counts a mixed one by its regular tabs', () => {
    const privateTab = (id: string, folderId: string): Tab =>
      ({ ...tab(id, folderId), containerId: 'private' }) as Tab
    // Ghost: a folder the tablet's sidebar filled with private tabs alone; Later: no tab at all;
    // Work: one regular tab beside a private one; Trip: saved pages and a private tab dropped in.
    const trip = folder('trip', { savedTabs: [{ url: 'https://t.example/', title: 't' }] })
    const { rows } = pane(
      [folder('ghost'), folder('later'), folder('work'), trip],
      [
        privateTab('g1', 'ghost'),
        privateTab('g2', 'ghost'),
        tab('w1', 'work'),
        privateTab('w2', 'work'),
        privateTab('t1', 'trip')
      ]
    )
    expect(rows.open.map((row) => [row.folder.id, row.kind, row.count])).toEqual([
      ['later', 'empty', 0],
      ['work', 'open', 1]
    ])
    expect(rows.saved.map((row) => [row.folder.id, row.kind, row.count])).toEqual([
      ['trip', 'saved', 1]
    ])
    expect(texts('.zen-list-title')).toEqual(['Later', 'Work', 'Trip'])
    expect(texts('.zen-overview-groups-aside')).toEqual(['2', '1'])
    expect(all('.zen-phone-row').some((row) => row.textContent?.includes('Ghost'))).toBe(false)
    // A pane of private-only groups alone is a pane at none.
    pane([folder('ghost')], [privateTab('g1', 'ghost')])
    expect(all('.zen-phone-row')).toHaveLength(0)
    expect(q('.zen-overview-groups > .zen-phone-empty')).not.toBeNull()
  })

  it('draws the group’s colour in the row’s glyph: a 12 px dot for an open group, a 2 px ring for a saved one', () => {
    pane(
      [
        folder('work'),
        folder('trip', { color: 'green', savedTabs: [{ url: 'https://t.example/', title: 't' }] })
      ],
      [tab('w1', 'work')]
    )
    const dot = rowNamed('Work').querySelector<HTMLElement>('.zen-overview-group-glyph')!
    const ring = rowNamed('Trip').querySelector<HTMLElement>('.zen-overview-group-glyph')!
    expect(dot.style.getPropertyValue('--zen-group-color')).toBe(FOLDER_COLORS.blue)
    expect(dot.hasAttribute('data-saved')).toBe(false)
    expect(ring.style.getPropertyValue('--zen-group-color')).toBe(FOLDER_COLORS.green)
    expect(ring.hasAttribute('data-saved')).toBe(true)
    const glyph = rule('.zen-overview-group-glyph')
    expect(glyph).toContain('width: 12px')
    expect(glyph).toContain('height: 12px')
    expect(glyph).toContain('background: var(--zen-group-color)')
    const saved = rule('.zen-overview-group-glyph[data-saved]')
    expect(saved).toContain('border: 2px solid var(--zen-group-color)')
    expect(saved).toContain('background: transparent')
    // The pane speaks the window family (§9.29): the theme's ink and fills, no rule of its own for the rows.
    const pane_ = rule('.zen-overview-groups')
    expect(pane_).toContain('--v2-text: var(--v2-control-text)')
    expect(pane_).toContain('--v2-text-deemphasized: var(--v2-control-text-deemphasized)')
    expect(pane_).toContain('--v2-fill: var(--v2-control-fill)')
    expect(css).not.toMatch(/\.zen-overview-groups \.zen-phone-row\b/)
  })

  it('opens the group on a tap and its sheet on the hold or the trailing button; the empty group is deaf to the tap alone', () => {
    const picks = pane([folder('work'), folder('later')], [tab('w1', 'work')])
    const work = rowNamed('Work')
    act(() => {
      work.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(picks.opened.map((r) => [r.folder.id, r.kind])).toEqual([['work', 'open']])
    act(() => {
      work.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(picks.menus.map((r) => r.folder.id)).toEqual(['work'])
    act(() => work.querySelector<HTMLElement>('[aria-label="More options for Work"]')!.click())
    expect(picks.menus.map((r) => r.folder.id)).toEqual(['work', 'work'])

    // An empty group: the row at §9.30's one disabled number, kept for its sheet.
    const later = rowNamed('Later')
    expect(later.hasAttribute('data-disabled')).toBe(true)
    act(() => {
      later.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(picks.opened).toHaveLength(1)
    act(() => {
      later.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(picks.menus.map((r) => r.folder.id)).toEqual(['work', 'work', 'later'])
  })

  it('puts the name being edited in the row’s title slot, saving on Enter and giving the old name back on Escape', () => {
    uiStore.set({ renamingFolderId: 'work' })
    pane([folder('work')], [tab('w1', 'work')], 'work')
    const row = q<HTMLElement>('[data-testid="overview-group-rename"]')!
    expect(row.hasAttribute('data-static')).toBe(true)
    expect(row.querySelector('.zen-overview-group-glyph')).not.toBeNull()
    const field = row.querySelector<HTMLInputElement>('input[aria-label="Group name"]')!
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe('Work')
    expect(field.className).toContain('zen-overview-group-rename')
    // The field at the row's 15 (§9.13), not the card's 13.
    const rename = rule('.zen-overview-groups .zen-overview-group-rename')
    expect(rename).toContain('font-size: var(--v2-font-body)')

    type(field, 'Reading')
    act(() => {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    expect(run).toHaveBeenCalledWith('folder.update', {
      folderId: 'work',
      patch: { name: 'Reading' }
    })
    expect(uiStore.get().renamingFolderId).toBeNull()

    vi.mocked(run).mockClear()
    uiStore.set({ renamingFolderId: 'work' })
    pane([folder('work')], [tab('w1', 'work')], 'work')
    const again = q<HTMLInputElement>('[data-testid="overview-group-rename"] input')!
    type(again, 'Nope')
    act(() => {
      again.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(run).not.toHaveBeenCalled()
    expect(uiStore.get().renamingFolderId).toBeNull()
  })

  it('at none is a list’s §9.17 sentence – the phone panels’ note, in the pane’s flow under the segment, with height and inside the pane’s box', () => {
    pane([])
    const paneEl = q<HTMLElement>('[data-testid="overview-groups"]')!
    const note = q<HTMLElement>('.zen-overview-groups > .zen-phone-empty')!
    expect(note).not.toBeNull()

    // The FORM: `PhoneEmptyNote` – one sentence in one paragraph, sentence case, no full stop; no
    // title-plus-description pair (the page form is the Private pane's, not a list's), no button
    // (the grid is where a group is made), no row and no heading beside it.
    expect(note.querySelectorAll('p')).toHaveLength(1)
    expect(note.querySelector('h1, h2, h3')).toBeNull()
    expect(note.querySelector('button')).toBeNull()
    const sentence = note.querySelector('p')!.textContent!
    expect(sentence).toBe('Hold a tab’s card and drop it on another to group them')
    expect(sentence).toMatch(/^[A-Z]/)
    expect(sentence).not.toMatch(/[.;!?]/)
    expect(all('.zen-phone-row')).toHaveLength(0)
    expect(all('.zen-v2-heading')).toHaveLength(0)

    // The BOX. happy-dom lays nothing out, so the box is pinned by what makes it: the note is
    // the pane's one child, IN FLOW – no `absolute`, no translate, no `flex-1` of a block parent
    // (the pane root is a scrolling block, not a flex column) and no inline geometry – so it
    // stands under the segment inside the pane's box like a row would, and its height is its
    // padding plus its line boxes: the note's rule pads it 40 / 32 / 24 (`phonePanels.css`) and
    // the pane's own rule lifts the top to 48, the first line's distance from the segment, which
    // carries no air under it. The preview host's probe and the driver's claim read the painted
    // rectangle itself.
    expect(note.parentElement).toBe(paneEl)
    expect(paneEl.childElementCount).toBe(1)
    expect(paneEl.className).toContain('overflow-y-auto')
    expect(paneEl.className.split(/\s+/)).not.toContain('flex')
    expect(note.className).toBe('zen-phone-empty')
    expect(note.getAttribute('style')).toBeNull()
    expect(note.querySelector('p')!.attributes).toHaveLength(0)
    const panels = readFileSync(resolve(__dirname, '../phonePanels.css'), 'utf8')
    const noteRule = panels.slice(panels.indexOf('.zen-phone-empty {'))
    const noteBody = noteRule.slice(0, noteRule.indexOf('}'))
    expect(noteBody).toContain('display: flex')
    expect(noteBody).toContain('flex-direction: column')
    expect(noteBody).toContain('align-items: center')
    expect(noteBody).toContain('padding: 40px 32px 24px')
    expect(noteBody).toContain('text-align: center')
    expect(noteBody).toContain('font-size: var(--v2-font-body)')
    expect(noteBody).toContain('color: var(--v2-text-deemphasized)')
    expect(noteBody).not.toContain('position')
    expect(rule('.zen-overview-groups > .zen-phone-empty')).toContain('padding-top: 48px')
    // Nothing of the old page form is left in the stylesheet to position it.
    expect(css).not.toContain('.zen-overview-groups-empty')
  })
})

// --- the row's sheet -------------------------------------------------------------------------

const sheetLabels = (): string[] => texts('.zen-sheet .zen-sheet-item')

function sheetItem(label: string): HTMLButtonElement {
  return all('.zen-sheet .zen-sheet-item').find((el) =>
    el.textContent?.trim().startsWith(label)
  ) as HTMLButtonElement
}

interface SheetPicks {
  opened: GroupRow[]
  closed: Folder[]
  deleted: GroupRow[]
}

/** A fresh sheet: the one before, dismissed, is unmounted first. */
function rowSheet(row: GroupRow): SheetPicks {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  const picks: SheetPicks = { opened: [], closed: [], deleted: [] }
  render(
    <GroupRowSheet
      row={row}
      onClose={noop}
      onOpen={(r) => picks.opened.push(r)}
      onCloseGroup={(f) => picks.closed.push(f)}
      onDelete={(r) => picks.deleted.push(r)}
    />
  )
  return picks
}

describe('the row’s sheet (TAB-16, §9.1, §6)', () => {
  it('for an open group: Show in Tabs, Rename, Close Group (N Tabs) in the plain ink, Delete Group in the danger ink', () => {
    const rows = rowsOf([folder('work')], [tab('w1', 'work'), tab('w2', 'work')])
    rowSheet(rows.open[0])
    expect(q('.zen-sheet .zen-sheet-title')?.textContent).toBe('Work')
    expect(sheetLabels()).toEqual([
      'Show in Tabs',
      'Rename',
      'Close Group (2 Tabs)',
      'Delete Group'
    ])
    // Close Group destroys nothing the saved group does not keep: the plain ink (§6).
    expect(sheetItem('Close Group').style.color).toBe('')
    expect(sheetItem('Delete Group').style.color).toBe('var(--zen-danger)')
    // The colour swatches: Chrome's nine as a radio group, the group's checked.
    const swatches = all('.zen-sheet [role="radiogroup"][aria-label="Colour"] [role="radio"]')
    expect(swatches).toHaveLength(9)
    expect(swatches.filter((s) => s.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    expect(
      swatches.find((s) => s.getAttribute('aria-checked') === 'true')?.getAttribute('aria-label')
    ).toBe('Blue')
    act(() => swatches.find((s) => s.getAttribute('aria-label') === 'Green')!.click())
    expect(run).toHaveBeenCalledWith('folder.update', {
      folderId: 'work',
      patch: { color: 'green' }
    })
  })

  it('for a saved group: Open (N Tabs), Rename, Delete Group – nothing to close; one page in the singular', () => {
    const rows = rowsOf([
      folder('trip', { savedTabs: [{ url: 'https://t.example/', title: 't' }] })
    ])
    rowSheet(rows.saved[0])
    expect(sheetLabels()).toEqual(['Open (1 Tab)', 'Rename', 'Delete Group'])
    expect(sheetItem('Delete Group').style.color).toBe('var(--zen-danger)')
  })

  it('for an empty group: Rename and Delete Group alone', () => {
    const rows = rowsOf([folder('later')])
    rowSheet(rows.open[0])
    expect(sheetLabels()).toEqual(['Rename', 'Delete Group'])
  })

  it('Rename puts the row into its editing state; the other rows hand the group back to the pane', () => {
    const rows = rowsOf([folder('work')], [tab('w1', 'work')])
    // A picked row slides the sheet away and acts once it is gone (at once here: the sheet has
    // no height to travel in happy-dom).
    let picks = rowSheet(rows.open[0])
    act(() => sheetItem('Show in Tabs').click())
    settle()
    expect(picks.opened.map((r) => r.folder.id)).toEqual(['work'])
    rowSheet(rows.open[0])
    act(() => sheetItem('Rename').click())
    settle()
    expect(uiStore.get().renamingFolderId).toBe('work')
    picks = rowSheet(rows.open[0])
    act(() => sheetItem('Close Group').click())
    settle()
    expect(picks.closed.map((f) => f.id)).toEqual(['work'])
    picks = rowSheet(rows.open[0])
    act(() => sheetItem('Delete Group').click())
    settle()
    expect(picks.deleted.map((r) => r.folder.id)).toEqual(['work'])
  })
})

// --- Delete Group's prompt -------------------------------------------------------------------

describe('Delete Group’s prompt (§9.23)', () => {
  it('for an open group names the tabs that close and the Undo that brings them back, Delete alone in the danger ink', () => {
    const rows = rowsOf([folder('work')], [tab('w1', 'work'), tab('w2', 'work'), tab('w3', 'work')])
    const confirmed: GroupRow[] = []
    render(
      <>
        <FrameDialogHost frame />
        <DeleteGroupSheet row={rows.open[0]} onClose={noop} onConfirm={(r) => confirmed.push(r)} />
      </>
    )
    const sheet = q<HTMLElement>('.zen-sheet[role="dialog"]')!
    expect(sheet.textContent).toContain('Delete Work?')
    expect(sheet.textContent).toContain(
      'Its 3 tabs close and the group goes; Undo on the toast brings the tabs back, ungrouped.'
    )
    const buttons = all('.zen-sheet .zen-sheet-footer button')
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Cancel', 'Delete'])
    expect(buttons[0].hasAttribute('data-danger')).toBe(false)
    expect(buttons[1].hasAttribute('data-danger')).toBe(true)
    expect(buttons[1].dataset.testid).toBe('overview-delete-group-confirm')
    // Cancel keeps the group: nothing confirmed.
    act(() => buttons[0].click())
    settle()
    expect(confirmed).toEqual([])
  })

  it('for a saved group says its pages are forgotten with no undo', () => {
    const rows = rowsOf([
      folder('trip', {
        savedTabs: [
          { url: 'https://a.example/', title: 'a' },
          { url: 'https://b.example/', title: 'b' }
        ]
      })
    ])
    const confirmed: GroupRow[] = []
    render(
      <>
        <FrameDialogHost frame />
        <DeleteGroupSheet row={rows.saved[0]} onClose={noop} onConfirm={(r) => confirmed.push(r)} />
      </>
    )
    const sheet = q<HTMLElement>('.zen-sheet[role="dialog"]')!
    expect(sheet.textContent).toContain('Delete Trip?')
    expect(sheet.textContent).toContain('Its 2 tabs are forgotten with it. There is no undo.')
    act(() => q<HTMLElement>('[data-testid="overview-delete-group-confirm"]')!.click())
    settle()
    expect(confirmed.map((r) => r.folder.id)).toEqual(['trip'])
  })
})
