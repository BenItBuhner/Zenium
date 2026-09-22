import type { JSX } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronLeft, ChevronRight, Download, Info } from 'lucide-react'
import type { MenuDescriptor, MenuGlyph, MenuItemDescriptor } from '@shared/types'
import { anchorOf, placeUnder, popOrigin, type Anchor } from '@renderer/lib/anchor'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { APP_MENU_BUTTON } from '@renderer/lib/mediaHub'
import { isIconRow } from '@renderer/lib/menuIconRow'
import { handleMenuKey } from '@renderer/lib/menuKeys'
import {
  HOVER_TO_OPEN_MS,
  closedTo,
  focusAfterClose,
  focusAfterOpen,
  openedAt,
  type PathFocus
} from '@renderer/lib/menuPath'
import { sourceTitle } from '@renderer/lib/menuTitle'
import { useSheetLeave } from '@renderer/lib/motion/presence'
import { openedFromKeyboard } from '@renderer/lib/popover'
import {
  ChromePortal,
  besideOrigin,
  intrinsicSize,
  layoutRect,
  placeBeside,
  popoverStyle,
  rowRect,
  useLightDismiss,
  viewportSize,
  type PopoverBox
} from '@renderer/lib/portals'
import { closeMenu, lastPointer, pickMenuItem } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { ReloadStopGlyph, StarGlyph } from '../phone/BarGlyphs'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { TabletMenu } from '../tablet/TabletMenu'

/**
 * Renders a `menu.show` descriptor for hosts without native popup menus. A phone gets a bottom
 * sheet with drill-in submenus; a tablet gets the §9.20 popover anchored to its button or the
 * finger's point, with cascading submenus (`TabletMenu`, v2 §9.36: a sheet at the foot of a
 * 1280 window is a reach away from the ⋯ that opened it – the shared `.zen-v2-menu` in its
 * tablet pose); a mouse (DeX, tablets with a trackpad) gets the shared `.zen-v2-menu` popover
 * with cascading submenus (`Popover` below), the vocabulary every menu the renderer draws shares
 * with `LocalMenu` and the bookmarks bar's folder panels.
 */
export function MenuSheet({ menu }: { menu: MenuDescriptor }): JSX.Element {
  const viewport = useViewport()
  if (viewport.formFactor === 'tablet') return <TabletMenu menu={menu} />
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
  const titleId = useId()

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
      labelledBy={titleId}
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
              <ChevronLeft className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </button>
          )}
          <h2 id={titleId} className="zen-sheet-title">
            {title}
          </h2>
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
                  {item.note ? (
                    // An empty state's sentence (§9.17): a row of the group, not a command.
                    <p className="zen-sheet-note">{item.label}</p>
                  ) : (
                    <button
                      type="button"
                      disabled={!item.enabled}
                      className={cn('zen-sheet-item', item.danger && 'text-[var(--zen-danger)]')}
                      // A checked row draws a check; the tree carries the state (A11Y-01), as the
                      // extensions sheet's rows do.
                      role={
                        item.type === 'checkbox'
                          ? 'menuitemcheckbox'
                          : item.type === 'radio'
                            ? 'menuitemradio'
                            : undefined
                      }
                      aria-checked={
                        item.type === 'checkbox' || item.type === 'radio' ? item.checked : undefined
                      }
                      onClick={() => {
                        if (item.submenu) setNav((n) => ({ path: [...n.path, item], direction: 1 }))
                        else sheet.current?.dismiss(() => pickMenuItem(item.id))
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {(item.type === 'checkbox' || item.type === 'radio') && item.checked && (
                        <Check className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
                      )}
                      {item.submenu && (
                        <ChevronRight
                          className="zen-sheet-item-secondary h-5 w-5 shrink-0"
                          strokeWidth={1.75}
                          aria-hidden
                        />
                      )}
                    </button>
                  )}
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
 * The star is the row's one stateful glyph (`StarGlyph`, shared with the bar's Bookmark):
 * `checked` is the page's bookmark. A press on an unfilled star fills it at once, on the fill's
 * spring, as the sheet starts to leave – the core saves the bookmark once the sheet is gone
 * (`pickMenuItem` runs the item then), so the fill would otherwise land on a sheet nobody can
 * see. A filled star opens the bookmark's editor (Chrome's flow) and stays filled.
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

// ---------------------------------------------------------------------------
// Popover (mouse)
// ---------------------------------------------------------------------------

/** One open panel of the cascade: the row whose submenu it lists (null at the root), and its rows. */
interface Level {
  parentId: string | null
  items: MenuItemDescriptor[]
}

/** Where a level goes once measured, and where its pop grows from. */
interface Placement {
  box: PopoverBox
  origin: string
}

/**
 * Where the keyboard is to land once the level at `depth` stands: its first row (a level the
 * keyboard opened), the row that had opened a deeper level (that level closed), or the panel
 * itself, which hears the keys without highlighting a row (opened by the pointer, §9.22).
 */
type FocusWanted = PathFocus | { depth: number; target: 'panel' }

/**
 * The levels open for `path` – the ids of the submenu rows open at each depth – from the root's
 * items down; a path through a row that has no submenu (or is disabled) stops there.
 */
function cascadeLevels(items: MenuItemDescriptor[], path: readonly string[]): Level[] {
  const levels: Level[] = [{ parentId: null, items }]
  for (const id of path) {
    const row = levels[levels.length - 1].items.find((item) => item.id === id)
    if (!row?.submenu || !row.enabled) break
    levels.push({ parentId: id, items: row.submenu })
  }
  return levels
}

/** The rows of a panel, in order. */
function menuRows(panel: HTMLElement | null | undefined): HTMLElement[] {
  return [...(panel?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
}

/**
 * The control the app menu hangs from: the "⋯" button on screen – the sidebar's toolbar row's
 * (`APP_MENU_BUTTON`) or a web app window's title bar's – read live as the menu mounts, since
 * the row remounts its buttons with the tab and the width. None for any other menu, or for an
 * app menu asked for with no button laid out (the compact sidebar's row away): that one hangs
 * from the point the descriptor names, as a context menu does.
 */
function appMenuButton(menu: MenuDescriptor): HTMLElement | null {
  if (menu.source !== 'app') return null
  const button = document.querySelector<HTMLElement>(APP_MENU_BUTTON)
  return button?.isConnected && button.checkVisibility() ? button : null
}

/**
 * The descriptor as the shared `.zen-v2-menu` (§4, §5, §6 menus; the vocabulary `LocalMenu` and
 * the bookmarks bar's folder panels draw in), through the chrome layer: a `--v2-panel` at radius
 * 8 – 6 for a context menu, every source but the `···`'s app menu (§2) – with 6 of padding and
 * 31 rows at the 14 px chrome menu size, intrinsic within 232–332 by its longest row, the chord
 * of a bound row after its label in the deemphasised ink. A context menu hangs from the point
 * the descriptor names (a control's bottom-left, the pointer); the app menu from the "⋯" button
 * it finds on screen, as the chrome's other popovers hang from their controls (`placeUnder`,
 * §9.20: flush under the bar the button sits in – gap 0 – end-aligned when the button is in the
 * bar's trailing half, flipped or slid inside the window's 8 margin), the button wearing
 * `aria-expanded` and its pressed fill while the menu stands. A checked row draws its check in the 16
 * glyph slot, a row with a favicon the favicon there; a submenu row trails the chevron and
 * opens its panel beside the one it is in (`placeBeside`, `placePopover`'s cascade mode: first
 * row on the row that opened it) after the pointer rests on it, or at once from the keyboard –
 * the row keeping the fill while its panel stands (`aria-expanded`).
 *
 * The keyboard is §9.22's, Chrome's native menus as the rule book: opened from the keyboard the
 * first row takes the focus, by pointer the panel itself does and Down starts at the first row;
 * the arrows, Home and End move within the level, Tab and Shift+Tab walk it too and wrap – the
 * menu is the keyboard's while it stands, nothing under it is reachable – Right opens a submenu
 * row's panel on its first row, Left and Backspace close the deepest level onto the row that
 * opened it (at the root, the menu), a letter goes to or runs the row it names (mnemonics,
 * a11y-08), Enter and Space run the row; Escape closes the deepest level, then the menu – onto
 * the control that opened it when a control of the chrome's had the focus as the menu came (the
 * ··· the pointer pressed or the keyboard opened from; the app menu's button whenever it is on
 * screen), which keeps the keyboard, as `LocalMenu` does through `usePopover`; the page takes
 * it back only when it had it (§9.22). Light dismiss is the chrome layer's (§9.20 amended): a
 * press outside the cascade, a scroll, a resize or another popover closes it, and a press on the
 * button that opened it closes it without reopening, the keyboard staying on the button. The
 * host is told of a pick (`pickMenuItem`) and of a close (`closeMenu`).
 */
function Popover({ menu }: { menu: MenuDescriptor }): JSX.Element {
  useBackSurface({ name: 'menu', onCommit: () => closeMenu() })
  // The "⋯" button an app menu hangs from, if one is on screen (read once, as the menu mounts).
  const [button] = useState(() => appMenuButton(menu))
  // Anchor at the button's box in its bar, else at the point that opened the menu: the control's
  // edge when the core named one, else the pointer position captured before the round trip.
  const anchor = useMemo<Anchor>(
    () =>
      button
        ? anchorOf(button)
        : { x: menu.x ?? lastPointer.x, y: menu.y ?? lastPointer.y, width: 0, height: 0 },
    [button, menu.id, menu.x, menu.y] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const [fromKeyboard] = useState(() => menu.keyboard ?? openedFromKeyboard())
  const context = menu.source !== 'app'

  const [path, setPath] = useState<string[]>([])
  const levels = useMemo(() => cascadeLevels(menu.items, path), [menu.items, path])
  const groupRef = useRef<HTMLDivElement>(null)
  const panelEls = useRef<(HTMLDivElement | null)[]>([])

  // The button keeps its pressed fill and says what it has open while the menu stands (§9.20);
  // at rest it is the toolbar's own again.
  useLayoutEffect(() => {
    if (!button) return
    button.setAttribute('aria-expanded', 'true')
    return () => button.removeAttribute('aria-expanded')
  }, [button])

  // The control the menu opened from – what had the focus as the menu mounted, the ··· the
  // pointer pressed or the keyboard opened from, else the app menu's button itself – for
  // Escape's way back (§9.22, as `usePopover` reads it). None when nothing of the chrome's had
  // the focus (the page did, or a control the press did not focus) and no button is on screen:
  // the page takes the keyboard back then, as after any overlay.
  const [opener] = useState<HTMLElement | null>(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : button
  )
  const returning = useRef(false)
  /** The keyboard closes the whole menu (Escape, Left or Backspace at the root). */
  const closeFromKeyboard = (): void => {
    returning.current = opener !== null && opener.isConnected
    closeMenu(true, { keepKeyboard: returning.current })
  }
  useLayoutEffect(
    () => () => {
      // A layout cleanup runs before React removes the nodes: the focus, if it is still in the
      // cascade, has not fallen to the body yet, and the opener can take it back in one step.
      if (!returning.current || !opener?.isConnected) return
      if (!groupRef.current?.contains(document.activeElement)) return
      opener.focus({ preventScroll: true })
    },
    [opener]
  )
  const [focusWanted, setFocusWanted] = useState<FocusWanted | null>(() => ({
    depth: 0,
    target: fromKeyboard ? 'first' : 'panel'
  }))
  const onFocused = useCallback((): void => setFocusWanted(null), [])

  const openLevel = useCallback((depth: number, rowId: string, focus: boolean): void => {
    setFocusWanted(focus ? focusAfterOpen(depth) : null)
    setPath((p) => openedAt(p, depth, rowId))
  }, [])
  /** Close the levels deeper than `depth` (level `depth` stays); `focus` lands on the row that opened them. */
  const closeTo = useCallback(
    (depth: number, focus: boolean): void => {
      setFocusWanted(focus ? focusAfterClose(path, depth) : null)
      setPath((p) => closedTo(p, depth))
    },
    [path]
  )

  // A press on the button that opened it closes the menu without reopening (the registry
  // swallows the rest of the press) and leaves the keyboard on the button (§9.22); any other
  // press outside, a scroll or a resize closes it and the page takes the keyboard back.
  useLightDismiss(groupRef, (reason) => closeMenu(true, { keepKeyboard: reason === 'anchor' }), {
    anchor: () => button
  })
  useEscape(() => {
    if (path.length) closeTo(path.length - 1, true)
    else closeFromKeyboard()
  })

  // The pointer: a submenu row opens beside after a rest, any other row closes what is deeper.
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelHover = useCallback((): void => {
    if (hover.current !== null) clearTimeout(hover.current)
    hover.current = null
  }, [])
  useEffect(() => cancelHover, [cancelHover])
  const hoverRow = (depth: number, item: MenuItemDescriptor): void => {
    cancelHover()
    const wanted = item.submenu && item.enabled ? item.id : null
    if (wanted === (path[depth] ?? null)) return
    hover.current = setTimeout(() => {
      hover.current = null
      if (wanted) openLevel(depth, wanted, false)
      else closeTo(depth, false)
    }, HOVER_TO_OPEN_MS)
  }

  const activate = (depth: number, item: MenuItemDescriptor, focus: boolean): void => {
    cancelHover()
    if (item.submenu) openLevel(depth, item.id, focus)
    else pickMenuItem(item.id)
  }

  /** The level the keyboard is in: the one holding the focus, else the deepest. */
  const focusedDepth = (): number => {
    const active = document.activeElement
    const at = panelEls.current.findIndex((el) => el?.contains(active))
    return at === -1 ? levels.length - 1 : at
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const depth = focusedDepth()
    const rows = menuRows(panelEls.current[depth])
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const current = at === -1 ? undefined : levels[depth]?.items.filter(isRow)[at]
    switch (e.key) {
      case 'ArrowRight':
        if (current?.submenu && current.enabled) openLevel(depth, current.id, true)
        break
      case 'ArrowLeft':
      case 'Backspace':
        if (depth > 0) closeTo(depth - 1, true)
        else closeFromKeyboard()
        break
      default:
        // The arrows, Home, End and a letter, as in Chrome's native menus (lib/menuKeys.ts); Tab
        // and Shift+Tab walk the level too and wrap, nothing under the menu being reachable.
        if (!handleMenuKey(e, rows, { mnemonics: true, tab: true })) return
        e.stopPropagation()
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  // Placement: the root under its anchor (flush under the bar the button sits in, else under
  // the point), every other level beside the row that opened it. A menu is exempt from §9.20's
  // 60% cap (§6 "Menus"): it takes the room down to the window's 8 px bottom margin and scrolls
  // only past that, so the app menu stands whole on an 800 px window.
  const place = useCallback(
    (depth: number, parentId: string | null, el: HTMLElement): Placement | null => {
      const viewport = viewportSize()
      // The used size, with the fraction of a pixel the longest row runs to: pinned to the
      // offsets' rounded width the row would end in an ellipsis (§5).
      const size = intrinsicSize(el)
      if (depth === 0 || parentId === null) {
        const box = placeUnder(anchor, { measured: size.width }, size.height, viewport, undefined, {
          capHeight: false
        })
        return { box, origin: popOrigin(anchor, box) }
      }
      const parent = panelEls.current[depth - 1]
      const row = parent?.querySelector<HTMLElement>(`[data-menu-row="${parentId}"]`)
      if (!parent || !row) return null
      const parentBox = layoutRect(parent)
      const rowBox = rowRect(row, parent, parentBox)
      const box = placeBeside(rowBox, parentBox, viewport, size)
      const height = Math.min(size.height, box.maxHeight)
      return { box, origin: besideOrigin(rowBox, box, viewport, height) }
    },
    [anchor]
  )

  return (
    <ChromePortal>
      {/* A menu the keyboard opened paints the focused row as the cursor from its first focus
          (§9.22): from Alt+F / F10 while the page had the keyboard no key event reaches this
          document, so `:focus-visible` alone would leave the first row bare. */}
      <div
        ref={groupRef}
        className={cn('contents', fromKeyboard && 'zen-v2-menu-keyboard')}
        onKeyDown={onKeyDown}
      >
        {levels.map((level, depth) => (
          <MenuLevel
            key={`${depth}/${level.parentId ?? ''}`}
            ref={(el) => {
              panelEls.current[depth] = el
            }}
            depth={depth}
            level={level}
            label={
              depth === 0 ? (menu.title ?? sourceTitle(menu.source)) : levelTitle(levels, depth)
            }
            context={context}
            openId={path[depth] ?? null}
            focus={focusWanted?.depth === depth ? focusWanted.target : null}
            onFocused={onFocused}
            place={place}
            onEnterPanel={cancelHover}
            onHoverRow={hoverRow}
            onActivate={(item, focus) => activate(depth, item, focus)}
            onScrolled={() => closeTo(depth, false)}
          />
        ))}
      </div>
    </ChromePortal>
  )
}

/** The items drawn as menuitems, in the order `menuRows` finds them: no separator, no note. */
const isRow = (item: MenuItemDescriptor): boolean => item.type !== 'separator' && !item.note

/** A submenu level's name to the tree: the label of the row that opened it. */
function levelTitle(levels: Level[], depth: number): string {
  const parentId = levels[depth]?.parentId
  const row = levels[depth - 1]?.items.find((item) => item.id === parentId)
  return row?.label ?? 'Menu'
}

/**
 * One panel of the cascade. It renders hidden at the window's origin first, so its intrinsic
 * width and height can be measured (layout size, not the client rect the pop animation's first
 * frame scales to .94), then takes the place `place` gives it; the placed width and height cap
 * are lifted for the measure when its rows change. Once it stands it takes the focus asked of it.
 */
function MenuLevel({
  ref,
  depth,
  level,
  label,
  context,
  openId,
  focus,
  onFocused,
  place,
  onEnterPanel,
  onHoverRow,
  onActivate,
  onScrolled
}: {
  ref: (el: HTMLDivElement | null) => void
  depth: number
  level: Level
  label: string
  context: boolean
  /** The submenu row whose panel is open beside this one. */
  openId: string | null
  /** Where the keyboard lands once the panel stands, if it is this panel's turn. */
  focus: FocusWanted['target'] | null
  onFocused: () => void
  place: (depth: number, parentId: string | null, el: HTMLElement) => Placement | null
  onEnterPanel: () => void
  onHoverRow: (depth: number, item: MenuItemDescriptor) => void
  /** `focus`: the keyboard did it (Enter, a mnemonic), so a submenu's level takes the focus. */
  onActivate: (item: MenuItemDescriptor, focus: boolean) => void
  /** The rows scrolled: whatever stood beside one of them no longer lines up. */
  onScrolled: () => void
}): JSX.Element {
  const el = useRef<HTMLDivElement | null>(null)
  const { parentId, items } = level
  const [placed, setPlaced] = useState<Placement | null>(null)
  useLayoutEffect(() => {
    const node = el.current
    if (!node) return
    node.style.width = ''
    node.style.maxHeight = ''
    setPlaced(place(depth, parentId, node))
  }, [depth, parentId, items.length, place])
  useLayoutEffect(() => {
    const node = el.current
    if (!node || !placed || !focus) return
    const rows = menuRows(node)
    const row =
      focus === 'panel'
        ? null
        : focus === 'first'
          ? rows[0]
          : rows.find((r) => r.dataset.menuRow === focus.id)
    ;(row ?? node).focus({ preventScroll: true })
    onFocused()
  }, [focus, onFocused, placed])
  // The glyph slot stands before every label when any row of the level has something to put in
  // it – a favicon, a check – so the labels share one edge.
  const withGlyphs = items.some(
    (item) => item.icon || item.type === 'checkbox' || item.type === 'radio'
  )
  return (
    <div
      ref={(node) => {
        el.current = node
        ref(node)
      }}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className="zen-v2 zen-v2-panel zen-v2-menu zen-animate-pop fixed select-none"
      data-context={context || undefined}
      style={{
        ...(placed ? popoverStyle(placed.box) : { left: 0, top: 0 }),
        visibility: placed ? 'visible' : 'hidden',
        transformOrigin: placed?.origin
      }}
      onPointerEnter={onEnterPanel}
      onScroll={onScrolled}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => {
        if (item.type === 'separator')
          return <div key={item.id} className="zen-v2-menu-separator" role="separator" />
        // An empty state's sentence (§9.17): a row in the deemphasised ink that is not a
        // menuitem – the arrows, Tab and the pointer pass it by – keeping the labels' edge.
        if (item.note)
          return (
            <div key={item.id} className="zen-v2-menu-note" data-menu-note>
              {withGlyphs && <span className="zen-v2-menu-glyph" aria-hidden />}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </div>
          )
        const checkable = item.type === 'checkbox' || item.type === 'radio'
        return (
          <button
            key={item.id}
            type="button"
            role={
              item.type === 'checkbox'
                ? 'menuitemcheckbox'
                : item.type === 'radio'
                  ? 'menuitemradio'
                  : 'menuitem'
            }
            tabIndex={-1}
            data-menu-row={item.id}
            data-danger={item.danger || undefined}
            disabled={!item.enabled}
            aria-checked={checkable ? item.checked : undefined}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? openId === item.id : undefined}
            className="zen-v2-menu-item"
            onPointerEnter={() => onHoverRow(depth, item)}
            // A click the keyboard made (Enter, Space, a mnemonic's: `detail` 0) is the
            // keyboard's activation, so a submenu's level takes the focus.
            onClick={(e) => onActivate(item, e.detail === 0)}
          >
            {withGlyphs && (
              <span className="zen-v2-menu-glyph" aria-hidden>
                {checkable && item.checked ? (
                  <Check />
                ) : item.icon ? (
                  <img src={item.icon} alt="" className="h-4 w-4 rounded-sm" draggable={false} />
                ) : null}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.hint && (
              <span className="zen-v2-menu-hint" aria-hidden>
                {item.hint}
              </span>
            )}
            {item.submenu && <ChevronRight className="zen-v2-menu-chevron" aria-hidden />}
          </button>
        )
      })}
    </div>
  )
}
