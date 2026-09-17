import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import type { MenuDescriptor, MenuItemDescriptor } from '@shared/types'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { closeMenu, lastPointer, pickMenuItem } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/**
 * Renders a `menu.show` descriptor for hosts without native popup menus. Touch gets a bottom
 * sheet with drill-in submenus; a mouse (DeX, tablets with a trackpad) gets an anchored popover
 * with flyout submenus, styled like the rest of Zen's panels.
 */
export function MenuSheet({ menu }: { menu: MenuDescriptor }): JSX.Element {
  const viewport = useViewport()
  return viewport.coarse ? <MenuBottomSheet menu={menu} /> : <Popover menu={menu} />
}

/** Escape closes either variant (hardware keyboards exist on tablets and DeX too). */
function useEscape(close: () => void): void {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        latest.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

// ---------------------------------------------------------------------------
// Bottom sheet (touch)
// ---------------------------------------------------------------------------

interface MenuNav {
  path: MenuItemDescriptor[]
  /** Which way the last drill went; 0 until the first one, so the root list does not slide in. */
  direction: 1 | -1 | 0
}

/**
 * The menu as a draggable sheet: sections are `.zen-sheet-card` groups of rows set apart by
 * spacing and a faint lift instead of rules, with radii nested concentrically (sheet 28 − 12
 * padding = card 16, card 16 − 4 padding = row 12). Picking a row slides the sheet away first,
 * so the host never snapshots the menu when it dims the page for whatever the row opens.
 */
function MenuBottomSheet({ menu }: { menu: MenuDescriptor }): JSX.Element {
  const [nav, setNav] = useState<MenuNav>({ path: [], direction: 0 })
  const { path } = nav
  const title = path.length ? path[path.length - 1].label : sourceTitle(menu.source)
  const groups = useMemo(
    () => groupItems(path.length ? (path[path.length - 1].submenu ?? []) : menu.items),
    [path, menu.items]
  )
  const sheet = useRef<BottomSheetHandle>(null)

  // The system back gesture drives the sheet's own dismissal: the finger pulls it down, commit
  // slides it away, cancel springs it back; the back button and Escape slide it away too.
  useBackSurface({
    name: 'menu',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(() => sheet.current?.dismiss())

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={() => closeMenu()}
      contentKey={`${menu.id}:${path.map((item) => item.id).join('/')}`}
      handleLabel="Resize menu"
      header={
        <div className="flex h-11 items-center gap-1">
          {path.length > 0 && (
            <button
              type="button"
              className="zen-toolbar-button h-9 w-9"
              onClick={() => setNav((n) => ({ path: n.path.slice(0, -1), direction: -1 }))}
              aria-label="Back"
            >
              <ChevronLeft className="h-[18px] w-[18px]" />
            </button>
          )}
          <span className="min-w-0 flex-1 truncate px-2 text-[15px] font-semibold">{title}</span>
        </div>
      }
    >
      <div
        key={path.length}
        className={cn(
          'flex flex-col gap-2 pb-2 pt-1',
          nav.direction > 0 && 'zen-drawer-right',
          nav.direction < 0 && 'zen-drawer-left'
        )}
      >
        {groups.map((group, index) => (
          <ul key={index} className="zen-sheet-card p-1">
            {group.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={!item.enabled}
                  className="zen-sheet-item"
                  onClick={() => {
                    if (item.submenu) setNav((n) => ({ path: [...n.path, item], direction: 1 }))
                    else sheet.current?.dismiss(() => pickMenuItem(item.id))
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {(item.type === 'checkbox' || item.type === 'radio') && item.checked && (
                    <Check className="h-[18px] w-[18px] shrink-0" />
                  )}
                  {item.submenu && (
                    <ChevronRight className="h-[18px] w-[18px] shrink-0 opacity-50" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </BottomSheet>
  )
}

/** Rows between separators form a group; the separators themselves are not drawn. */
function groupItems(items: MenuItemDescriptor[]): MenuItemDescriptor[][] {
  const groups: MenuItemDescriptor[][] = []
  let group: MenuItemDescriptor[] = []
  for (const item of items) {
    if (item.type === 'separator') {
      if (group.length) groups.push(group)
      group = []
    } else {
      group.push(item)
    }
  }
  if (group.length) groups.push(group)
  return groups
}

function sourceTitle(source: MenuDescriptor['source']): string {
  switch (source) {
    case 'page':
      return 'Page'
    case 'tab':
      return 'Tab'
    case 'selection':
      return 'Selected Tabs'
    case 'space':
      return 'Space'
    case 'folder':
      return 'Folder'
    case 'newtab':
      return 'New Tab'
    case 'app':
      return 'Zenium'
  }
}

// ---------------------------------------------------------------------------
// Popover (mouse)
// ---------------------------------------------------------------------------

const ITEM_H = 28
const SEP_H = 9
const PAD = 6
const MENU_W = 240

function itemOffsets(items: MenuItemDescriptor[]): number[] {
  const tops: number[] = []
  let offset = PAD
  for (const item of items) {
    tops.push(offset)
    offset += item.type === 'separator' ? SEP_H : ITEM_H
  }
  return tops
}

function Popover({ menu }: { menu: MenuDescriptor }): JSX.Element {
  useBackSurface({ name: 'menu', onCommit: () => closeMenu() })
  useEscape(() => closeMenu())
  // Anchor at the click that opened the menu (pointer position captured before the round trip).
  const anchor = useMemo(
    () => ({ x: menu.x ?? lastPointer.x, y: menu.y ?? lastPointer.y }),
    [menu.id, menu.x, menu.y] // eslint-disable-line react-hooks/exhaustive-deps
  )
  return (
    <div
      className="fixed inset-0 z-[90]"
      onClick={() => closeMenu()}
      onContextMenu={(e) => {
        e.preventDefault()
        closeMenu()
      }}
    >
      <MenuList items={menu.items} x={anchor.x} y={anchor.y} depth={0} />
    </div>
  )
}

function MenuList({
  items,
  x,
  y,
  depth
}: {
  items: MenuItemDescriptor[]
  x: number
  y: number
  depth: number
}): JSX.Element {
  const ref = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Keep the list inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))
    setPos({ left, top })
  }, [x, y, items])

  // Vertical offset of every item, so flyouts line up with the row that opened them.
  const tops = useMemo(() => itemOffsets(items), [items])
  return (
    <ul
      ref={ref}
      className="zen-panel zen-animate-pop fixed select-none p-1.5"
      style={{ left: pos.left, top: pos.top, width: MENU_W, zIndex: 91 + depth }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {items.map((item, index) => {
        const itemTop = tops[index]
        if (item.type === 'separator')
          return <li key={item.id} className="my-1 h-px bg-[var(--zen-border)]" />
        const isOpen = open === item.id
        return (
          <li key={item.id} className="relative">
            <button
              type="button"
              disabled={!item.enabled}
              className={cn(
                'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px]',
                'hover:bg-[var(--zen-element-bg-hover)] disabled:opacity-40',
                isOpen && 'bg-[var(--zen-element-bg-hover)]'
              )}
              onPointerEnter={() => setOpen(item.submenu ? item.id : null)}
              onClick={() => {
                if (item.submenu) setOpen(item.id)
                else pickMenuItem(item.id)
              }}
            >
              <span className="w-3.5 shrink-0">
                {item.type === 'checkbox' && item.checked && <Check className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.submenu && <ChevronRight className="h-3.5 w-3.5 opacity-60" />}
            </button>
            {isOpen && item.submenu && item.enabled && (
              <MenuList
                items={item.submenu}
                x={pos.left + MENU_W - 4}
                y={pos.top + itemTop - PAD}
                depth={depth + 1}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
