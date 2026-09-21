import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import type { MenuDescriptor, MenuItemDescriptor } from '@shared/types'
import { usePopover } from '@renderer/hooks/usePopover'
import { popOrigin } from '@renderer/lib/anchor'
import { useBackSurface } from '@renderer/lib/back'
import { handleMenuKey } from '@renderer/lib/menuKeys'
import { sourceTitle } from '@renderer/lib/menuTitle'
import { openedFromKeyboard } from '@renderer/lib/popover'
import { ChromePortal, popoverStyle, useLightDismiss, type PopoverBox } from '@renderer/lib/portals'
import { closeMenu, pickMenuItem } from '@renderer/lib/ui'
import { placeCascade, placeRootMenu, resolveMenuAnchor } from './tabletMenuPlacement'

/**
 * The tablet's menu (v2 §9.36, §9.20): the app menu and the context menus as anchored popovers
 * – Chrome's and Firefox's tablet menus anchor; a bottom sheet at the foot of a 1280 window is
 * a phone pattern whose origin is a reach away from the ⋯ that opened it. One panel at Zen's
 * 332 on the §9.20 chassis, 44 rows with a 20 glyph slot (the check of a checked row, an item's
 * favicon), hairline separators, the labels in the core's Title Case; it pops from where the
 * anchor meets it and closes without motion. A row with a submenu opens it as a second panel
 * flush beside the first (the cascade), the row keeping its lit fill and `aria-expanded` while
 * the child is up; picking a row anywhere runs it and closes the whole menu.
 *
 * Light dismiss is the chrome layer's (`useLightDismiss`): a press outside the panels closes
 * the menu and is consumed, the ⋯'s own press closes it without reopening, a scroll, a resize
 * or another popover opening close it too. The system back gesture closes it as well. The
 * keyboard is `usePopover`'s (§9.22), for the hardware keyboard a tablet may have: once the
 * panel is placed, focus moves into it – its first row when the ⋯ was reached with the
 * keyboard, the panel itself after a finger – so the arrows, Home / End and the mnemonics of
 * `handleMenuKey` work from the first key; Escape closes the topmost panel (a cascade first,
 * then the menu); and when the menu goes, focus returns to the control that opened it. The
 * page under it is its capture (`showMenu` takes it before the menu shows, and `ui.menu` keeps
 * the frame covered), so the panel is never under the page's view.
 */
export function TabletMenu({ menu }: { menu: MenuDescriptor }): JSX.Element {
  useBackSurface({ name: 'menu', onCommit: () => closeMenu() })
  // Resolved once per menu: the anchor does not move while the menu is up (§9.20 computes once
  // on open; a resize closes the menu instead).
  const anchor = useMemo(
    () => resolveMenuAnchor(menu),
    [menu.id] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const panel = useRef<HTMLUListElement>(null)
  const [box, setBox] = useState<PopoverBox | null>(null)
  // Measured before its first paint: the rows' own height (`--v2-menu-row` grows with the
  // system font size) decides below or above, the cap decides the scroll.
  useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    setBox(placeRootMenu(anchor, el.scrollHeight + 2))
  }, [anchor, menu.items])
  // Read at mount, before focus moves into the panel: the ⋯'s ring says the keyboard opened it.
  const [fromKeyboard] = useState(openedFromKeyboard)
  usePopover(panel, {
    onClose: () => closeMenu(),
    active: box !== null,
    initial: fromKeyboard ? 'first' : 'container'
  })
  useLightDismiss(panel, () => closeMenu(), {
    anchor: () => (anchor.kind === 'control' ? anchor.element : null)
  })
  // The control the menu hangs from stays lit while it is up (§9.20: Zen's menu button).
  useEffect(() => {
    if (anchor.kind !== 'control') return
    const el = anchor.element
    el.setAttribute('aria-expanded', 'true')
    el.setAttribute('data-menu-open', '')
    return () => {
      el.setAttribute('aria-expanded', 'false')
      el.removeAttribute('data-menu-open')
    }
  }, [anchor])
  const origin = !box
    ? undefined
    : anchor.kind === 'control'
      ? popOrigin(anchor.box, box)
      : popOrigin({ x: anchor.x, y: anchor.y, width: 0, height: 0 }, box)
  return (
    <ChromePortal>
      <MenuPanel
        ref={panel}
        items={menu.items}
        label={menu.title ?? sourceTitle(menu.source)}
        style={
          box
            ? { ...popoverStyle(box), transformOrigin: origin }
            : { left: 0, top: 0, visibility: 'hidden' }
        }
        depth={0}
        data-source={menu.source}
        data-side={box?.side}
        data-anchor={anchor.kind}
      />
    </ChromePortal>
  )
}

interface PanelProps {
  ref: React.Ref<HTMLUListElement>
  items: MenuItemDescriptor[]
  label: string
  style: React.CSSProperties
  depth: number
  /** A cascade's way back to its parent row on the keyboard (Left, as native menus have it). */
  onLeft?: () => void
  'data-source'?: string
  'data-side'?: string
  'data-anchor'?: string
}

/**
 * One panel of rows: the root, or a cascade. `role="menu"` with `menuitem` rows (checkbox and
 * radio rows carry their state, A11Y-01) straight under it in the tree – the `<li>` wrappers
 * are `role="none"`, a `menu` owns only items, groups and separators; the arrows and mnemonics
 * move among its own rows. The panel takes focus itself (`tabIndex -1`) when a finger opened it.
 */
function MenuPanel({ ref, items, label, style, depth, onLeft, ...data }: PanelProps): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    // A cascade's keys are the cascade's: its panel is a portal under the parent row in React's
    // tree, so its events bubble up here, and the parent's rows must not answer them.
    if ((e.target as HTMLElement).closest('[role="menu"]') !== e.currentTarget) return
    if (e.key === 'ArrowLeft' && onLeft) {
      e.preventDefault()
      e.stopPropagation()
      onLeft()
      return
    }
    const list = items
      .filter((item) => item.type !== 'separator')
      .map((item) => rows.current.get(item.id))
      .filter((el): el is HTMLButtonElement => Boolean(el))
    handleMenuKey(e, list, { mnemonics: true })
  }
  return (
    <ul
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className="zen-tablet-menu zen-animate-pop fixed flex flex-col select-none outline-none"
      style={{ ...style, zIndex: 91 + depth }}
      data-depth={depth}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      {...data}
    >
      {items.map((item) =>
        item.type === 'separator' ? (
          <li key={item.id} role="separator" className="zen-tablet-menu-sep" />
        ) : (
          <MenuRow
            key={item.id}
            item={item}
            depth={depth}
            expanded={open === item.id}
            register={(el) => {
              if (el) rows.current.set(item.id, el)
              else rows.current.delete(item.id)
            }}
            onToggle={() => setOpen((id) => (id === item.id ? null : item.id))}
          />
        )
      )}
    </ul>
  )
}

function MenuRow({
  item,
  depth,
  expanded,
  register,
  onToggle
}: {
  item: MenuItemDescriptor
  depth: number
  expanded: boolean
  register: (el: HTMLButtonElement | null) => void
  onToggle: () => void
}): JSX.Element {
  const row = useRef<HTMLButtonElement>(null)
  const checkable = item.type === 'checkbox' || item.type === 'radio'
  const submenu = item.submenu && item.enabled ? item.submenu : null
  return (
    <li role="none" className="relative">
      <button
        ref={(el) => {
          row.current = el
          register(el)
        }}
        type="button"
        role={
          item.type === 'checkbox'
            ? 'menuitemcheckbox'
            : item.type === 'radio'
              ? 'menuitemradio'
              : 'menuitem'
        }
        aria-checked={checkable ? item.checked : undefined}
        aria-haspopup={submenu ? 'menu' : undefined}
        aria-expanded={submenu ? expanded : undefined}
        disabled={!item.enabled}
        className="zen-tablet-menu-item"
        data-danger={item.danger || undefined}
        onClick={() => {
          if (submenu) onToggle()
          else pickMenuItem(item.id)
        }}
        onKeyDown={(e) => {
          // Right opens a row's cascade as native menus do (Enter and Space open it as a click).
          if (submenu && !expanded && e.key === 'ArrowRight') {
            e.preventDefault()
            e.stopPropagation()
            onToggle()
          }
        }}
      >
        <span className="zen-tablet-menu-glyph" aria-hidden>
          {checkable && item.checked ? (
            <Check strokeWidth={1.75} />
          ) : item.icon ? (
            <img src={item.icon} alt="" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {submenu && (
          <ChevronRight className="zen-tablet-menu-chevron" strokeWidth={1.75} aria-hidden />
        )}
      </button>
      {submenu && expanded && (
        <Cascade
          items={submenu}
          label={item.label}
          parentRow={row}
          depth={depth + 1}
          onClose={onToggle}
        />
      )}
    </li>
  )
}

/**
 * A submenu's panel beside its parent, level with the row that opened it. Its light dismiss
 * registers with that row as its anchor, so the layer knows it for the parent's child: a press
 * inside it leaves the parent open, and the row's own press closes it (`onToggle`). Its keyboard
 * is `usePopover`'s too: opened from the keyboard it takes its first row, opened by a finger it
 * leaves focus on the parent row; Escape closes the cascade alone (it is the topmost popup) and
 * focus goes back to the row that opened it.
 */
function Cascade({
  items,
  label,
  parentRow,
  depth,
  onClose
}: {
  items: MenuItemDescriptor[]
  label: string
  parentRow: React.RefObject<HTMLButtonElement | null>
  depth: number
  onClose: () => void
}): JSX.Element {
  const panel = useRef<HTMLUListElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const [fromKeyboard] = useState(openedFromKeyboard)
  usePopover(panel, {
    onClose,
    active: pos !== null,
    initial: fromKeyboard ? 'first' : 'none',
    returnTo: parentRow
  })
  useLayoutEffect(() => {
    const el = panel.current
    const rowEl = parentRow.current
    const parentPanel = rowEl?.closest<HTMLElement>('.zen-tablet-menu')
    if (!el || !rowEl || !parentPanel) return
    const parent = parentPanel.getBoundingClientRect()
    const row = rowEl.getBoundingClientRect()
    setPos(
      placeCascade(
        { left: parent.left, width: parent.width },
        // Level with the row, the panel's padding above the first row taken back.
        row.top - 4 - 1,
        el.scrollHeight + 2
      )
    )
  }, [parentRow, items])
  useLightDismiss(panel, () => closeMenu(), { anchor: parentRow })
  return (
    <ChromePortal>
      <MenuPanel
        ref={panel}
        items={items}
        label={label}
        style={
          pos
            ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
            : { left: 0, top: 0, visibility: 'hidden' }
        }
        depth={depth}
        onLeft={onClose}
      />
    </ChromePortal>
  )
}
