import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import type { Rect } from '@shared/types'
import { anchorBelow } from '@renderer/lib/extensions/popupPlacement'
import { useViewport } from '@renderer/lib/formFactor'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

export interface LocalMenuItem {
  id: string
  /** Title Case, as Zen's menu items are (v2 draft §9.1). */
  label: string
  icon?: LucideIcon
  danger?: boolean
  disabled?: boolean
  /** Keyboard hint at the right (desktop only). */
  hint?: string
  onSelect: () => void
}

export interface LocalMenuSeparator {
  id: string
  type: 'separator'
}

export type LocalMenuEntry = LocalMenuItem | LocalMenuSeparator

interface Props {
  /** The control that opened the menu, in window coordinates. */
  anchor: Rect
  items: LocalMenuEntry[]
  onClose: () => void
  /** Title of the phone sheet (the thing the menu is about). */
  title?: string
}

function isSeparator(entry: LocalMenuEntry): entry is LocalMenuSeparator {
  return 'type' in entry && entry.type === 'separator'
}

/**
 * A menu the renderer owns (v2 draft §6 menus): on a mouse a bordered panel at radius 8 under
 * its control with 31 rows, a 16 icon each when any has one, hairline separators and danger
 * rows in the danger ink; on a finger the same rows at 44 in a bottom sheet. Escape and an
 * outside click (or a tap on the scrim) close it; there is no scrim on the desktop (§9.5).
 */
export function LocalMenu(props: Props): JSX.Element {
  const viewport = useViewport()
  return createPortal(
    viewport.coarse ? <SheetMenu {...props} /> : <PopoverMenu {...props} />,
    document.body
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

function PopoverMenu({ anchor, items, onClose }: Props): JSX.Element {
  useEscape(onClose)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; side: 'left' | 'right' } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const placed = anchorBelow(
      anchor,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight }
    )
    setPos({ left: placed.x, top: placed.y, side: placed.side })
  }, [anchor, items.length])
  const withIcons = items.some((item) => !isSeparator(item) && item.icon)
  return (
    <div
      className="fixed inset-0 z-[90]"
      onMouseDown={(e) => {
        e.stopPropagation()
        onClose()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div
        ref={ref}
        role="menu"
        className="zen-v2 zen-v2-panel zen-v2-menu zen-animate-pop fixed select-none"
        style={{
          left: pos?.left ?? anchor.x,
          top: pos?.top ?? anchor.y + anchor.height + 8,
          visibility: pos ? 'visible' : 'hidden',
          transformOrigin: pos?.side === 'right' ? '100% 0' : '0 0'
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((entry) =>
          isSeparator(entry) ? (
            <div key={entry.id} className="zen-v2-menu-separator" role="separator" />
          ) : (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              className="zen-v2-menu-item"
              data-danger={entry.danger || undefined}
              disabled={entry.disabled}
              onClick={() => {
                onClose()
                entry.onSelect()
              }}
            >
              {withIcons && (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {entry.icon && <entry.icon />}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.hint && <span className="zen-v2-menu-hint">{entry.hint}</span>}
            </button>
          )
        )}
      </div>
    </div>
  )
}

function SheetMenu({ items, title, onClose }: Props): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  useEscape(() => sheet.current?.dismiss())
  const withIcons = items.some((item) => !isSeparator(item) && item.icon)
  return (
    <BottomSheet
      ref={sheet}
      onDismissed={onClose}
      handleLabel="Resize menu"
      header={title ? <div className="zen-v2 zen-v2-sheet-title">{title}</div> : undefined}
    >
      <div className="zen-v2 flex flex-col pb-2">
        {items.map((entry) =>
          isSeparator(entry) ? (
            <div key={entry.id} className="zen-v2-sheet-separator" role="separator" />
          ) : (
            <button
              key={entry.id}
              type="button"
              disabled={entry.disabled}
              className="zen-v2-sheet-row"
              data-danger={entry.danger || undefined}
              onClick={() => sheet.current?.dismiss(() => entry.onSelect())}
            >
              {withIcons && (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  {entry.icon && <entry.icon />}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            </button>
          )
        )}
      </div>
    </BottomSheet>
  )
}
