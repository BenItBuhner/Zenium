// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Tab } from '@shared/types'

/*
 * A group card's actions within a reader's reach (A11Y-10): the card's header is a button whose
 * tap folds the group and whose hold opens the group's sheet (Rename, Collapse / Expand,
 * Ungroup, Close Group, Delete Group). The hold is a gesture: Chromium's Android bridge exposes
 * no `ACTION_LONG_CLICK` and no custom action for a web node (ARIA has no vocabulary for one),
 * so TalkBack's actions menu on the header lists Collapse / Expand – the `aria-expanded` – and
 * nothing of the sheet's. Under touch exploration the card therefore draws the sheet's other
 * rows as controls by the same names (`groupCardControls`), next after the header and out of
 * sight; without it nothing is drawn, so a keyboard's Tab never stops on a control it cannot see.
 */

const invoke = vi.fn(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { GroupCard } = await import('../GroupCard')
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
  it('without touch exploration the header is the card’s one control – nothing a keyboard could Tab to unseen', () => {
    const el = card()
    expect(controls(el)).toBeNull()
    expect(el.querySelectorAll('button').length).toBe(0)
    expect(header(el).getAttribute('role')).toBe('button')
    expect(header(el).getAttribute('aria-expanded')).toBe('true')
  })

  it('under touch exploration the sheet’s rows stand as real buttons next after the header, by the same names, out of sight but in the tree', () => {
    act(() => applyAccessibilityState({ touchExploration: true, fontScale: 1 }))
    const el = card()
    expect(controls(el)).not.toBeNull()
    // Reading order: the header, then its actions, then the member cards.
    expect(header(el).nextElementSibling).toBe(controls(el))
    expect(names(el)).toEqual(['Rename', 'Ungroup', 'Close Group (3 Tabs)', 'Delete Group'])
    // The same names as the hold sheet's rows, from the one builder: every row but the fold,
    // which the header is itself (its tap, and Collapse / Expand in TalkBack's menu off
    // `aria-expanded`).
    const sheetRows = groupActions(folder(), 3, { closeGroup: onCloseGroup, deleteGroup: onDelete })
    expect(sheetRows.map((a) => a.label)).toEqual([
      'Rename',
      'Collapse',
      'Ungroup',
      'Close Group (3 Tabs)',
      'Delete Group'
    ])
    expect(
      groupCardControls(folder(), 3, { closeGroup: onCloseGroup, deleteGroup: onDelete }).map(
        (a) => a.label
      )
    ).toEqual(sheetRows.filter((a) => a.id !== 'collapse').map((a) => a.label))
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
      'ungroup',
      'close',
      'delete'
    ])
  })

  it('the count keeps its unit: one tab, "Close Group (1 Tab)"; folded, the same four (the fold is the header’s)', () => {
    act(() => applyAccessibilityState({ touchExploration: true, fontScale: 1 }))
    expect(names(card({ tabs: 1 }))).toEqual([
      'Rename',
      'Ungroup',
      'Close Group (1 Tab)',
      'Delete Group'
    ])
    act(() => root?.unmount())
    root = null
    const folded = card({ collapsed: true })
    expect(header(folded).getAttribute('aria-expanded')).toBe('false')
    expect(names(folded)).toEqual(['Rename', 'Ungroup', 'Close Group (3 Tabs)', 'Delete Group'])
  })

  it('follows the state live while the card stands: TalkBack coming on draws them, going off takes them away', () => {
    const el = card()
    expect(controls(el)).toBeNull()
    act(() => applyAccessibilityState({ touchExploration: true, fontScale: 1 }))
    expect(names(el)).toEqual(['Rename', 'Ungroup', 'Close Group (3 Tabs)', 'Delete Group'])
    act(() => applyAccessibilityState({ touchExploration: false, fontScale: 1 }))
    expect(controls(el)).toBeNull()
  })

  it('each control does what its row does: Rename edits the name in place, Ungroup asks the core, Close Group and Delete Group go to the overview', () => {
    act(() => applyAccessibilityState({ touchExploration: true, fontScale: 1 }))
    const el = card()
    const button = (name: string): HTMLButtonElement =>
      buttons(el).find((b) => b.textContent === name)!
    click(button('Rename'))
    expect(uiStore.get().renamingFolderId).toBe('g')
    // The header shows the name's field now; the controls stand on.
    expect(el.querySelector('input[aria-label="Group name"]')).not.toBeNull()
    expect(names(el)).toEqual(['Rename', 'Ungroup', 'Close Group (3 Tabs)', 'Delete Group'])
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
