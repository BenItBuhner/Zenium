import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronLeft, ChevronRight, Download, Info, Star } from 'lucide-react'
import type { MenuDescriptor, MenuGlyph, MenuItemDescriptor } from '@shared/types'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { isIconRow } from '@renderer/lib/menuIconRow'
import { useSheetLeave } from '@renderer/lib/motion/presence'
import { SPRING_SNAPPY, SpringAnimation, type SpringConfig } from '@renderer/lib/motion/spring'
import { closeMenu, lastPointer, pickMenuItem } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { ReloadStopGlyph } from '../phone/BarGlyphs'
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

/**
 * Escape closes either variant (hardware keyboards exist on tablets and DeX too). A menu that is
 * `leaving` – its request gone, its sheet on its way down under `SheetPresence` (§11.1) – lets
 * the key by: it answers nothing any more, and a menu that popped above it does.
 */
function useEscape(close: () => void, leaving = false): void {
  const latest = useRef({ close, leaving })
  useEffect(() => {
    latest.current = { close, leaving }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !latest.current.leaving) {
        e.preventDefault()
        e.stopImmediatePropagation()
        latest.current.close()
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
 * The menu as a draggable sheet, laid out like the rest of the chrome: rows in the sidebar's
 * type and radius, sections told apart by spacing alone, a title row like the drawer's. Picking
 * a row slides the sheet away first, so the host never snapshots the menu when it dims the page
 * for whatever the row opens.
 */
function MenuBottomSheet({ menu }: { menu: MenuDescriptor }): JSX.Element {
  const [nav, setNav] = useState<MenuNav>({ path: [], direction: 0 })
  const { path } = nav
  const title = path.length ? path[path.length - 1].label : (menu.title ?? sourceTitle(menu.source))
  const groups = useMemo(
    () => groupItems(path.length ? (path[path.length - 1].submenu ?? []) : menu.items),
    [path, menu.items]
  )
  const sheet = useRef<BottomSheetHandle>(null)

  // The system back gesture drives the sheet's own dismissal: the finger pulls it down, commit
  // slides it away, cancel springs it back; the back button and Escape slide it away too. On
  // its way out with its request gone (the chassis's leave) the sheet absorbs the gesture and
  // the menu lets Escape by.
  useBackSurface({
    name: 'menu',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(() => sheet.current?.dismiss(), useSheetLeave()?.leaving)

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={() => closeMenu()}
      contentKey={`${menu.id}:${path.map((item) => item.id).join('/')}`}
      handleLabel="Resize menu"
      header={
        <>
          {path.length > 0 && (
            <button
              type="button"
              className="zen-sheet-header-control"
              data-side="leading"
              onClick={() => setNav((n) => ({ path: n.path.slice(0, -1), direction: -1 }))}
              aria-label="Back"
            >
              <ChevronLeft className="h-5 w-5" strokeWidth={1.75} />
            </button>
          )}
          <span className="zen-sheet-title">{title}</span>
        </>
      }
    >
      <div
        key={path.length}
        className={cn(
          'flex flex-col pb-1',
          nav.direction > 0 && 'zen-drawer-right',
          nav.direction < 0 && 'zen-drawer-left'
        )}
      >
        {groups.map((group, index) =>
          isIconRow(group) ? (
            <ul key={index} className="zen-menu-icon-row" aria-label="Page actions">
              {group.map((item) => (
                <li key={item.id} className="flex">
                  <IconRowButton
                    item={item}
                    onPick={() => sheet.current?.dismiss(() => pickMenuItem(item.id))}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <ul key={index} className="flex flex-col">
              {index > 0 && <li aria-hidden className="zen-sheet-sep" />}
              {group.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={!item.enabled}
                    className={cn('zen-sheet-item', item.danger && 'text-[var(--zen-danger)]')}
                    onClick={() => {
                      if (item.submenu) setNav((n) => ({ path: [...n.path, item], direction: 1 }))
                      else sheet.current?.dismiss(() => pickMenuItem(item.id))
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {(item.type === 'checkbox' || item.type === 'radio') && item.checked && (
                      <Check className="h-5 w-5 shrink-0" strokeWidth={1.75} />
                    )}
                    {item.submenu && (
                      <ChevronRight
                        className="zen-sheet-item-secondary h-5 w-5 shrink-0"
                        strokeWidth={1.75}
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </BottomSheet>
  )
}

// ---------------------------------------------------------------------------
// The icon row (the phone app menu's first group; `lib/menuIconRow.ts` says which group)
// ---------------------------------------------------------------------------

/**
 * One button of the row: the shared v2 icon button (§9.3: 44 × 44, a 20 px glyph, the press
 * fill; disabled at .4, §9.30) named by the item's label (§9.22), drawing the glyph the core
 * named. Picking it slides the sheet away and then runs the item, as a text row does.
 *
 * The star is the row's one stateful glyph: `checked` is the page's bookmark. A press on an
 * unfilled star fills it at once, on the fill's spring, as the sheet starts to leave – the core
 * saves the bookmark once the sheet is gone (`pickMenuItem` runs the item then), so the fill
 * would otherwise land on a sheet nobody can see. A filled star opens the bookmark's editor
 * (Chrome's flow) and stays filled.
 */
function IconRowButton({
  item,
  onPick
}: {
  item: MenuItemDescriptor
  onPick: () => void
}): JSX.Element {
  const star = item.glyph === 'star'
  const [filled, setFilled] = useState(item.checked)
  return (
    <button
      type="button"
      className="zen-v2-icon-button"
      disabled={!item.enabled}
      aria-label={item.label}
      data-glyph={item.glyph}
      data-filled={star ? filled : undefined}
      onClick={() => {
        if (star && !filled) setFilled(true)
        onPick()
      }}
    >
      {item.glyph === 'star' ? (
        <StarGlyph filled={filled} />
      ) : (
        <MenuGlyphView glyph={item.glyph ?? 'info'} />
      )}
    </button>
  )
}

/** The row's still glyphs, the bar's own drawings for the same actions (`barItems.tsx`). */
function MenuGlyphView({ glyph }: { glyph: Exclude<MenuGlyph, 'star'> }): JSX.Element {
  switch (glyph) {
    case 'forward':
      return <ArrowRight aria-hidden />
    case 'download':
      return <Download aria-hidden />
    case 'info':
      return <Info aria-hidden />
    case 'reload':
    case 'stop':
      return <ReloadStopGlyph loading={glyph === 'stop'} />
  }
}

/**
 * `SPRING_SNAPPY` for the fill's 0…1 value. The shared spring's rest thresholds are in px and
 * px/s (`restDelta` .4, `restSpeed` 8), so on a unit value they would call the fill settled at
 * 60 percent and snap it to the end – a five-frame ramp and a cut, not a spring; a hundredth of
 * each lets the fill run to rest as a position does (22 frames at 60 Hz, .9 at 200 ms, at rest
 * by 370 ms, no frame stepping more than .13). `BarPreview`'s presence spring takes the same
 * numbers.
 */
const SPRING_FILL: SpringConfig = { ...SPRING_SNAPPY, restDelta: 0.004, restSpeed: 0.08 }

/**
 * The star with its fill: the outline, and over it a filled star whose opacity and scale one
 * `SPRING_SNAPPY` spring (`SPRING_FILL`, its rest at the unit's scale) writes per frame (design
 * language v2 §11: transform and opacity only, one interruptible spring – a change of mind before
 * it lands retargets the same motion; reduced motion jumps to the end). It opens at rest where
 * the bookmark is, with no motion of its own.
 */
function StarGlyph({ filled }: { filled: boolean }): JSX.Element {
  const fill = useRef<HTMLSpanElement>(null)
  const spring = useRef<SpringAnimation | null>(null)
  useEffect(() => {
    const el = fill.current
    if (!el) return
    const paint = (x: number): void => {
      el.style.opacity = String(Math.max(0, Math.min(1, x)))
      el.style.transform = `scale(${0.6 + 0.4 * x})`
    }
    const to = filled ? 1 : 0
    if (!spring.current) {
      spring.current = new SpringAnimation(SPRING_FILL, paint, paint)
      paint(to)
      spring.current.start(to, 0, to)
    } else spring.current.retarget(to)
  }, [filled])
  useEffect(() => () => void spring.current?.stop(), [])
  return (
    <span className="zen-menu-star" aria-hidden>
      <span>
        <Star />
      </span>
      <span ref={fill} className="zen-menu-star-fill">
        <Star fill="currentColor" />
      </span>
    </span>
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
    case 'topsite':
      return 'Shortcut'
    case 'app':
      return 'Zenium'
    case 'bookmark':
      return 'Bookmark'
    case 'history':
      return 'History'
    case 'download':
      return 'Download'
    case 'urlbar':
      return 'Address'
    case 'translate':
      return 'Translation'
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
                isOpen && 'bg-[var(--zen-element-bg-hover)]',
                item.danger && 'text-[var(--zen-danger)]'
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
