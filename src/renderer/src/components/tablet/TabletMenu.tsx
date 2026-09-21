import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import type { MenuDescriptor, MenuItemDescriptor } from '@shared/types'
import { popOrigin } from '@renderer/lib/anchor'
import { useBackSurface } from '@renderer/lib/back'
import { handleMenuKey } from '@renderer/lib/menuKeys'
import { sourceTitle } from '@renderer/lib/menuTitle'
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
 * or another popover opening close it too. The system back gesture and Escape close it as well
 * (a hardware keyboard on a tablet also has the arrows, Home / End and the mnemonics of
 * `handleMenuKey`). The page under it is its capture (`showMenu` takes it before the menu shows,
 * and `ui.menu` keeps the frame covered), so the panel is never under the page's view.
 */
export function TabletMenu({ menu }: { menu: MenuDescriptor }): JSX.Element {
  useBackSurface({ name: 'menu', onCommit: () => closeMenu() })
  useEscape(() => closeMenu())
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

function useEscape(close: () => void): void {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

interface PanelProps {
  ref: React.Ref<HTMLUListElement>
  items: MenuItemDescriptor[]
  label: string
  style: React.CSSProperties
  depth: number
  'data-source'?: string
  'data-side'?: string
  'data-anchor'?: string
}

/**
 * One panel of rows: the root, or a cascade. `role="menu"` with `menuitem` rows (checkbox and
 * radio rows carry their state, A11Y-01); the arrows and mnemonics move among its own rows.
 */
function MenuPanel({ ref, items, label, style, depth, ...data }: PanelProps): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
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
      className="zen-tablet-menu zen-animate-pop fixed flex flex-col select-none"
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
    <li className="relative">
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
        <Cascade items={submenu} label={item.label} parentRow={row} depth={depth + 1} />
      )}
    </li>
  )
}

/**
 * A submenu's panel beside its parent, level with the row that opened it. Its light dismiss
 * registers with that row as its anchor, so the layer knows it for the parent's child: a press
 * inside it leaves the parent open, and the row's own press closes it (`onToggle`).
 */
function Cascade({
  items,
  label,
  parentRow,
  depth
}: {
  items: MenuItemDescriptor[]
  label: string
  parentRow: React.RefObject<HTMLButtonElement | null>
  depth: number
}): JSX.Element {
  const panel = useRef<HTMLUListElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
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
      />
    </ChromePortal>
  )
}
