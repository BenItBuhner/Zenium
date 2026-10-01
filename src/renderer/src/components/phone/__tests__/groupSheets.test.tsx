// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Tab } from '@shared/types'
import { FOLDER_COLORS_DARK, FOLDER_COLORS_LIGHT } from '@shared/defaults'
import { hexToRgb } from '@shared/theme'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { folderDeleteWords } from '@renderer/lib/folderDelete'
import { groupRows, type GroupRow } from '@renderer/lib/groupRows'
import { FrameDialogHost } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'
import { DeleteGroupSheet, GroupRowSheet } from '../GroupSheets'

/*
 * The overview's group sheets rendered for real (TAB-16; tab overview cleanup spec §2, §9: the
 * Groups pane is gone – a saved group is a card with the saved ring at the grid's end, and
 * these are its sheets; design language v2 §9.1, §9.23, §6): the saved card's sheet by the
 * group's state – Close Group in the plain ink, Delete Group alone in the danger ink – with the
 * colour swatches, and Delete Group's §9.23 prompt.
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
 * The pane's rows for `folders`, their live members being the `tabs` that name them, private
 * ones (`containerId: 'private'`) among them the way the space holds them, as `TabOverview`
 * feeds it.
 */
function rowsOf(folders: Folder[], tabs: Tab[] = []): ReturnType<typeof groupRows> {
  return groupRows(folders, (folderId) => tabs.filter((t) => t.folderId === folderId))
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

const noop = (): void => undefined

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

describe('the saved card’s sheet (TAB-16, §9.1, §6)', () => {
  it('for a group come open under it: Show in Tabs, Rename, Close Group (N Tabs) in the plain ink, Delete Group in the danger ink', () => {
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
    // Each swatch carries §9.14's pair and shows the theme's pick: its disc reads
    // `--zen-group-rgb`, the picked one's ring the same; no hex on either.
    const green = swatches.find((s) => s.getAttribute('aria-label') === 'Green')!
    expect(green.hasAttribute('data-group-rgb')).toBe(true)
    expect(green.style.getPropertyValue('--zen-group-rgb-light')).toBe(
      hexToRgb(FOLDER_COLORS_LIGHT.green)!.join(' ')
    )
    expect(green.style.getPropertyValue('--zen-group-rgb-dark')).toBe(
      hexToRgb(FOLDER_COLORS_DARK.green)!.join(' ')
    )
    expect(green.style.getPropertyValue('--zen-swatch')).toBe('')
    const disc = green.firstElementChild as HTMLElement
    expect(disc.className).toContain('bg-[rgb(var(--zen-group-rgb))]')
    expect(disc.style.background).toBe('')
    expect(rule('.zen-group-swatch-selected')).toContain(
      'box-shadow: inset 0 0 0 2px rgb(var(--zen-group-rgb))'
    )
    act(() => green.click())
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
  it('for an open group names the tabs that close, each to Recently Closed – no Undo promised (TAB-13, option C) – Delete alone in the danger ink', () => {
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
    // The one source of the three hosts' words (`folderDeleteWords`, the group noun).
    expect(sheet.textContent).toContain(
      'Its 3 tabs close with it; Recently Closed keeps their pages.'
    )
    expect(sheet.textContent).not.toContain('Undo')
    expect(sheet.textContent).toContain(folderDeleteWords('Work', 3, false, 'group').detail)
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
    expect(sheet.textContent).toContain(
      'Its 2 saved pages are forgotten with it. There is no undo.'
    )
    expect(sheet.textContent).toContain(folderDeleteWords('Trip', 2, true, 'group').detail)
    act(() => q<HTMLElement>('[data-testid="overview-delete-group-confirm"]')!.click())
    settle()
    expect(confirmed.map((r) => r.folder.id)).toEqual(['trip'])
  })

  it('for a group with no name asks "Delete this group?" (v2 §6, the touch hosts’ noun; #711’s fallback), one tab in the singular', () => {
    const rows = rowsOf([folder('anon', { name: '  ' })], [tab('x1', 'anon')])
    render(
      <>
        <FrameDialogHost frame />
        <DeleteGroupSheet row={rows.open[0]} onClose={noop} onConfirm={noop} />
      </>
    )
    const sheet = q<HTMLElement>('.zen-sheet[role="dialog"]')!
    expect(sheet.textContent).toContain('Delete this group?')
    expect(sheet.textContent).toContain('Its 1 tab closes with it; Recently Closed keeps its page.')
    expect(sheet.textContent).not.toContain('Undo')
  })
})
