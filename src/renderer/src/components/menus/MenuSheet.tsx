import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import type { MenuDescriptor, MenuItemDescriptor } from '@shared/types'
import { useViewport } from '@renderer/lib/formFactor'
import { closeMenu, lastPointer, pickMenuItem, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'

/**
 * Renders a `menu.show` descriptor for hosts without native popup menus. Touch gets a bottom
 * sheet with drill-in submenus; a mouse (DeX, tablets with a trackpad) gets an anchored popover
 * with flyout submenus, styled like the rest of Zen's panels.
 */
export function MenuSheet({ menu }: { menu: MenuDescriptor }): JSX.Element {
  const viewport = useViewport()
  const sheet = viewport.coarse
  return sheet ? <BottomSheet menu={menu} /> : <Popover menu={menu} />
}

// ---------------------------------------------------------------------------
// Bottom sheet (touch)
// ---------------------------------------------------------------------------

function BottomSheet({ menu }: { menu: MenuDescriptor }): JSX.Element {
  const [path, setPath] = useState<MenuItemDescriptor[]>([])
  const current = path.length ? (path[path.length - 1].submenu ?? []) : menu.items
  const insets = uiStore.use((s) => s.insets)
  const title = path.length ? path[path.length - 1].label : sourceTitle(menu.source)

  return (
    <div
      className="fixed inset-0 z-[90] flex flex-col justify-end bg-black/40 zen-animate-fade"
      onClick={() => closeMenu()}
    >
      <div
        className="zen-panel zen-sheet-in mx-auto w-full max-w-[520px] rounded-b-none rounded-t-2xl border-b-0 pb-1"
        style={{ paddingBottom: Math.max(8, insets.bottom) }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-[var(--zen-fg)]/20" />
        <div className="flex h-11 items-center gap-1 px-2">
          {path.length > 0 && (
            <button
              type="button"
              className="zen-toolbar-button h-9 w-9"
              onClick={() => setPath((p) => p.slice(0, -1))}
              aria-label="Back"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          <span className="min-w-0 flex-1 truncate px-2 text-[13px] font-semibold">{title}</span>
        </div>
        <ul className="max-h-[60vh] overflow-y-auto px-2">
          {current.map((item) =>
            item.type === 'separator' ? (
              <li key={item.id} className="my-1 h-px bg-[var(--zen-border)]" />
            ) : (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={!item.enabled}
                  className={cn(
                    'flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px]',
                    'active:bg-[var(--zen-element-bg-hover)] disabled:opacity-40'
                  )}
                  onClick={() => {
                    if (item.submenu) setPath((p) => [...p, item])
                    else pickMenuItem(item.id)
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.type === 'checkbox' && item.checked && <Check className="h-4 w-4" />}
                  {item.submenu && <ChevronRight className="h-4 w-4 opacity-60" />}
                </button>
              </li>
            )
          )}
        </ul>
      </div>
    </div>
  )
}

function sourceTitle(source: MenuDescriptor['source']): string {
  switch (source) {
    case 'page':
      return 'Page'
    case 'tab':
      return 'Tab'
    case 'space':
      return 'Space'
    case 'folder':
      return 'Folder'
    case 'newtab':
      return 'New Tab'
    case 'app':
      return 'Zen'
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
  // Anchor at the click that opened the menu (pointer position captured before the round trip).
  const anchor = useMemo(
    () => ({ x: menu.x ?? lastPointer.x, y: menu.y ?? lastPointer.y }),
    [menu.id, menu.x, menu.y] // eslint-disable-line react-hooks/exhaustive-deps
  )
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMenu()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
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
