import type { SplitLayout, Tab, TabSection, UIState } from '@shared/types'
import { run } from './api'
import { browserStore, captureActiveTab, invalidateSnapshot, uiStore } from './ui'
import { activeTab, pinnedOf, regularOf } from './selectors'
import { createStore } from './store'

/**
 * Pointer-based drag & drop for sidebar tabs. Drop targets are DOM elements carrying a
 * `data-drop` attribute:
 *   tab:<tabId>:before|after     insert relative to another tab (same section)
 *   section:<section>:<spaceId>  append to a section (pinned | regular | essential)
 *   folder:<folderId>            move into a folder
 *   space:<spaceId>              move to another space
 *   split:<left|right|top|bottom> split with the active tab (dropped on the content area)
 */
export const dropStore = createStore<{ key: string | null }>({ key: null }, 'drop')

const DRAG_THRESHOLD = 5

export function startTabDrag(tab: Tab, e: React.PointerEvent): void {
  if (e.button !== 0) return
  // A finger dragging a tab row is a scroll (and a long-press is the context menu); only a mouse
  // drags tabs. Touch users move tabs through the tab menu (pin, essentials, space, split).
  if (e.pointerType !== 'mouse') return
  const startX = e.clientX
  const startY = e.clientY
  let dragging = false
  const pointerId = e.pointerId

  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
      dragging = true
      const state = browserStore.get().state
      const active = state ? activeTab(state) : null
      void captureActiveTab(active?.id ?? null).then(() => {
        if (dragging) uiStore.set({ drag: { tabId: tab.id, x: ev.clientX, y: ev.clientY } })
      })
      uiStore.set({ drag: { tabId: tab.id, x: ev.clientX, y: ev.clientY } })
      document.body.style.cursor = 'grabbing'
    }
    uiStore.set({ drag: { tabId: tab.id, x: ev.clientX, y: ev.clientY } })
    dropStore.set({ key: dropKeyAt(ev.clientX, ev.clientY, tab.id) })
  }

  const finish = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', cancel)
    if (!dragging) return
    dragging = false
    const key = dropKeyAt(ev.clientX, ev.clientY, tab.id)
    document.body.style.cursor = ''
    uiStore.set({ drag: null })
    dropStore.set({ key: null })
    invalidateSnapshot()
    if (key) performDrop(tab.id, key)
  }

  const cancel = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', cancel)
    dragging = false
    document.body.style.cursor = ''
    uiStore.set({ drag: null })
    dropStore.set({ key: null })
    invalidateSnapshot()
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', cancel)
}

function dropKeyAt(x: number, y: number, draggedId: string): string | null {
  const el = document.elementFromPoint(x, y)
  const target = el?.closest<HTMLElement>('[data-drop]')
  if (!target) return null
  const key = target.dataset.drop ?? null
  if (key && key.startsWith(`tab:${draggedId}:`)) return null
  return key
}

function performDrop(tabId: string, key: string): void {
  const state = browserStore.get().state
  if (!state) return
  const tab = state.tabs[tabId]
  if (!tab) return
  const parts = key.split(':')
  switch (parts[0]) {
    case 'tab': {
      const [, targetId, position] = parts
      const target = state.tabs[targetId]
      if (!target || target.id === tabId) return
      const section: TabSection = target.essential
        ? 'essential'
        : target.pinned
          ? 'pinned'
          : 'regular'
      const spaceId = target.spaceId ?? state.activeSpaceId
      const index = indexRelativeTo(state, target, position === 'after', tabId)
      run('tab.move', {
        tabId,
        spaceId: section === 'essential' ? undefined : spaceId,
        section,
        index
      })
      if (section === 'regular' && target.folderId !== tab.folderId)
        run('tab.moveToFolder', { tabId, folderId: target.folderId })
      return
    }
    case 'section': {
      const [, section, spaceId] = parts
      run('tab.move', {
        tabId,
        spaceId: spaceId || undefined,
        section: section as TabSection,
        index: Number.MAX_SAFE_INTEGER
      })
      if (section === 'regular' && tab.folderId) run('tab.moveToFolder', { tabId, folderId: null })
      return
    }
    case 'folder': {
      const folder = state.folders[parts[1]]
      if (!folder) return
      if (tab.spaceId !== folder.spaceId || tab.pinned || tab.essential) {
        run('tab.move', {
          tabId,
          spaceId: folder.spaceId,
          section: 'regular',
          index: Number.MAX_SAFE_INTEGER
        })
      }
      run('tab.moveToFolder', { tabId, folderId: folder.id })
      return
    }
    case 'space': {
      if (tab.essential) return
      run('tab.moveToSpace', { tabId, spaceId: parts[1] })
      return
    }
    case 'split': {
      const active = activeTab(state)
      if (!active || active.id === tabId) return
      const side = parts[1]
      const layout: SplitLayout = side === 'left' || side === 'right' ? 'vertical' : 'horizontal'
      if (active.splitGroupId) {
        run('split.addTab', { groupId: active.splitGroupId, tabId })
      } else {
        const ids = side === 'left' || side === 'top' ? [tabId, active.id] : [active.id, tabId]
        run('split.create', { tabIds: ids, layout })
      }
      return
    }
  }
}

/** Index within the target's section after removing the dragged tab from that list. */
function indexRelativeTo(state: UIState, target: Tab, after: boolean, draggedId: string): number {
  let list: Tab[]
  if (target.essential) {
    list = state.essentialTabIds.map((id) => state.tabs[id]).filter((t): t is Tab => Boolean(t))
  } else {
    const space = state.spaces.find((s) => s.id === target.spaceId) ?? state.spaces[0]
    list = target.pinned ? pinnedOf(state, space) : regularOf(state, space)
  }
  const ids = list.map((t) => t.id).filter((id) => id !== draggedId)
  const idx = ids.indexOf(target.id)
  if (idx === -1) return Number.MAX_SAFE_INTEGER
  return after ? idx + 1 : idx
}
