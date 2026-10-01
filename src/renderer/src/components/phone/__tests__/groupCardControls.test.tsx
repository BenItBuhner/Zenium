// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Tab } from '@shared/types'

/*
 * A group card's actions within a reader's reach (A11Y-10): the card's header is a button whose
 * tap folds the group and whose hold (or ⋯) opens the group's sheet (tab overview cleanup spec
 * §2: Rename, Colour – the sheet's palette – New Tab in Group, Ungroup, Close Group, Delete
 * Group). The hold is a gesture: Chromium's Android bridge exposes no `ACTION_LONG_CLICK` and
 * no custom action for a web node (ARIA has no vocabulary for one), so TalkBack's actions menu
 * on the header lists Collapse / Expand – the `aria-expanded` – and nothing of the sheet's.
 * Under touch exploration the card therefore draws the sheet's rows as controls by the same
 * names (`groupCardControls`), next after the header and out of sight; without it nothing is
 * drawn, so a keyboard's Tab never stops on a control it cannot see.
 */

const invoke = vi.fn(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { GroupCard } = await import('../GroupCard')
const { OVERVIEW_LABELS } = await import('@shared/overviewMenu')
const { groupActions, groupCardControls } = await import('../groupActions')
const { DEFAULT_FOLDER_ICON } = await import('@renderer/lib/groups')
const { applyAccessibilityState, resetAccessibilityState } =
  await import('@renderer/lib/accessibilityState')
const { auditNames, formatNameFindings } = await import('@renderer/lib/a11yNames')
const { uiStore } = await import('@renderer/lib/ui')

const folder = (over: Partial<Folder> = {}): Folder => ({
  id: 'g',
  spaceId: 'space',
  name: 'Research',
  icon: DEFAULT_FOLDER_ICON,
  collapsed: false,
  color: 'blue',
  ...over
})

const tab = (id: string): Tab =>
  ({
    id,
    spaceId: 'space',
    containerId: 'default',
    url: `https://${id}.example/`,
    title: id,
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: 'g',
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
  }) as Tab

let root: Root | null = null
let host: HTMLElement | null = null
const onNewTab = vi.fn<(folder: Folder) => void>()
const onCloseGroup = vi.fn<(folder: Folder) => void>()
const onDelete = vi.fn<(folder: Folder) => void>()

function render(element: JSX.Element): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(element))
  return host
}

function card(
  over: { collapsed?: boolean; tabs?: number; dissolving?: boolean } = {}
): HTMLElement {
  const tabs = Array.from({ length: over.tabs ?? 3 }, (_, i) => tab(`t${i}`))
  return render(
    createElement(GroupCard, {
      folder: folder({ collapsed: over.collapsed ?? false }),
      tabs,
      card: (t: Tab) => createElement('div', { key: t.id }, t.title),
      onMenu: () => undefined,
      onNewTab,
      onCloseGroup,
      onDelete,
      columns: 2,
      dissolving: over.dissolving,
      held: over.dissolving ? tabs.length : undefined
    })
  )
}

const header = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>('.zen-group-header')!
const controls = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>('[data-testid="group-card-controls"]')
const buttons = (el: HTMLElement): HTMLButtonElement[] => [
  ...el.querySelectorAll<HTMLButtonElement>('[data-testid="group-card-controls"] button')
]
const names = (el: HTMLElement): string[] => buttons(el).map((b) => b.textContent ?? '')
const click = (b: Element): void => {
  act(() => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  invoke.mockClear()
  onNewTab.mockClear()
  onCloseGroup.mockClear()
  onDelete.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  act(() => resetAccessibilityState())
  uiStore.set({ renamingFolderId: null })
})

describe('the group card under touch exploration (A11Y-10)', () => {
  it('without touch exploration the open card’s controls are the header and its visible ⋯ – nothing a keyboard could Tab to unseen; folded, the header alone', () => {
    const el = card()
    expect(controls(el)).toBeNull()
    // The open group's ⋯ (the cleanup spec §2) is a real, visible button beside the header,
    // named for the sheet it opens; it is the card's only button.
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([OVERVIEW_LABELS.groupOptions])
    expect(buttons[0].dataset.testid).toBe('group-card-options')
    expect(buttons[0].classList.contains('sr-only')).toBe(false)
    expect(header(el).getAttribute('role')).toBe('button')
    expect(header(el).getAttribute('aria-expanded')).toBe('true')
    act(() => root?.unmount())
    root = null
    // Folded, the card draws no ⋯: the header is the one control, the whole card its tap.
    const folded = card({ collapsed: true })
    expect(folded.querySelectorAll('button').length).toBe(0)
    expect(header(folded).getAttribute('aria-expanded')).toBe('false')
    const tap = folded.querySelector<HTMLElement>('[data-testid="group-card-tap"]')!
    expect(tap.getAttribute('aria-hidden')).toBe('true')
    expect(tap.hasAttribute('role')).toBe(false)
  })

  it('under touch exploration the sheet’s rows stand as real buttons next after the header and its ⋯, by the same names, out of sight but in the tree', () => {
    act(() => applyAccessibilityState({ touchExploration: true, fontScale: 1 }))
    const el = card()
    expect(controls(el)).not.toBeNull()
    // Reading order: the header, its ⋯, then its actions, then the member cards.
    const options = header(el).nextElementSibling as HTMLElement
    expect(options.dataset.testid).toBe('group-card-options')
    expect(options.nextElementSibling).toBe(controls(el))
    expect(names(el)).toEqual([
      'Rename',
      'New Tab in Group',
      'Ungroup',
      'Close Group (3 Tabs)',
      'Delete Group'
    ])
    // The same names as the sheet's rows, from the one builder: every row (§2's order, Colour
    // being the sheet's palette, not a row); the fold is no row – the header is itself (its
    // tap, and Collapse / Expand in TalkBack's menu off `aria-expanded`).
    const on = { newTabInGroup: onNewTab, closeGroup: onCloseGroup, deleteGroup: onDelete }
    const sheetRows = groupActions(folder(), 3, on)
    expect(sheetRows.map((a) => a.label)).toEqual([
      'Rename',
      'New Tab in Group',
      'Ungroup',
      'Close Group (3 Tabs)',
      'Delete Group'
    ])
    expect(sheetRows.map((a) => a.id)).toEqual(['rename', 'new-tab', 'ungroup', 'close', 'delete'])
    expect(groupCardControls(folder(), 3, on).map((a) => a.label)).toEqual(
      sheetRows.map((a) => a.label)
    )
    for (const b of buttons(el)) {
      expect(b.getAttribute('type')).toBe('button')
      // Visually hidden, not hidden from the tree: the screen-reader-only box, no `display:
      // none`, no `aria-hidden`, no `hidden`.
      expect(b.classList.contains('sr-only')).toBe(true)
      expect(b.hasAttribute('aria-hidden')).toBe(false)
      expect(b.hasAttribute('hidden')).toBe(false)
      expect(b.style.display).toBe('')
      // The name is the text (A11Y-10: what Voice Access hears is what the row reads).
      expect(b.hasAttribute('aria-label')).toBe(false)
      expect(b.disabled).toBe(false)
    }
    expect(formatNameFindings(auditNames(el))).toBe('')
    // The danger row keeps its mark for a reader of the source, not its ink: it is unseen.
    expect(buttons(el).map((b) => b.dataset.groupAction)).toEqual([
      'rename',
      'new-tab',
      'ungroup',
      'close',
      'delete'
    ])
  })

  it('the count keeps its unit: one tab, "Close Group (1 Tab)"; folded, the same five (the fold is the header’s)', () => {
    act(() => applyAccessibilityState({ touchExploration: true, fontScale: 1 }))
    expect(names(card({ tabs: 1 }))).toEqual([
      'Rename',
      'New Tab in Group',
      'Ungroup',
      'Close Group (1 Tab)',
      'Delete Group'
    ])
    act(() => root?.unmount())
    root = null
    const folded = card({ collapsed: true })
    expect(header(folded).getAttribute('aria-expanded')).toBe('false')
    expect(names(folded)).toEqual([
      'Rename',
      'New Tab in Group',
      'Ungroup',
      'Close Group (3 Tabs)',
      'Delete Group'
    ])
  })

  it('follows the state live while the card stands: TalkBack coming on draws them, going off takes them away', () => {
    const el = card()
    expect(controls(el)).toBeNull()
    act(() => applyAccessibilityState({ touchExploration: true, fontScale: 1 }))
    expect(names(el)).toEqual([
      'Rename',
      'New Tab in Group',
      'Ungroup',
      'Close Group (3 Tabs)',
      'Delete Group'
    ])
    act(() => applyAccessibilityState({ touchExploration: false, fontScale: 1 }))
    expect(controls(el)).toBeNull()
  })

  it('each control does what its row does: Rename edits the name in place, Ungroup asks the core, New Tab in Group, Close Group and Delete Group go to the overview', () => {
    act(() => applyAccessibilityState({ touchExploration: true, fontScale: 1 }))
    const el = card()
    const button = (name: string): HTMLButtonElement =>
      buttons(el).find((b) => b.textContent === name)!
    click(button('Rename'))
    expect(uiStore.get().renamingFolderId).toBe('g')
    // The header shows the name's field now; the controls stand on.
    expect(el.querySelector('input[aria-label="Group name"]')).not.toBeNull()
    expect(names(el)).toEqual([
      'Rename',
      'New Tab in Group',
      'Ungroup',
      'Close Group (3 Tabs)',
      'Delete Group'
    ])
    click(button('New Tab in Group'))
    expect(onNewTab).toHaveBeenCalledTimes(1)
    expect(onNewTab.mock.calls[0][0].id).toBe('g')
    click(button('Ungroup'))
    expect(invoke).toHaveBeenCalledWith('folder.delete', { folderId: 'g', unpack: true })
    click(button('Close Group (3 Tabs)'))
    expect(onCloseGroup).toHaveBeenCalledTimes(1)
    expect(onCloseGroup.mock.calls[0][0].id).toBe('g')
    click(button('Delete Group'))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete.mock.calls[0][0].id).toBe('g')
    // No press folded the group: the fold is the header's tap alone.
    expect(invoke).not.toHaveBeenCalledWith('folder.update', expect.anything())
  })

  it('a group shrinking away draws none: nothing to act on', () => {
    act(() => applyAccessibilityState({ touchExploration: true, fontScale: 1 }))
    expect(controls(card({ dissolving: true }))).toBeNull()
  })
})
