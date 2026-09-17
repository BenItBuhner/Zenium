import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import type { Rect } from '@shared/types'
import { anchorBelow } from '@renderer/lib/extensions/popupPlacement'
import { useViewport } from '@renderer/lib/formFactor'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

export interface LocalMenuItem {
  id: string
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
 * A menu the renderer owns (design-language.md §8.8): on a mouse a 240 panel 8px under its
 * control with 28 rows at radius 6, icons all-or-nothing, danger rows in the danger ink; on a
 * finger the same rows in a bottom sheet, grouped by a gap where the desktop draws a separator.
 * Escape and an outside click (or tap on the scrim) close it.
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
        className="zen-panel zen-menu zen-animate-pop fixed select-none"
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
            <div key={entry.id} className="zen-menu-separator" role="separator" />
          ) : (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              className="zen-menu-item"
              data-danger={entry.danger || undefined}
              disabled={entry.disabled}
              onClick={() => {
                onClose()
                entry.onSelect()
              }}
            >
              {withIcons && (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {entry.icon && <entry.icon className="h-4 w-4" />}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.hint && <span className="zen-menu-hint">{entry.hint}</span>}
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
  const groups: LocalMenuItem[][] = []
  let group: LocalMenuItem[] = []
  for (const entry of items) {
    if (isSeparator(entry)) {
      if (group.length) groups.push(group)
      group = []
    } else group.push(entry)
  }
  if (group.length) groups.push(group)
  const withIcons = items.some((item) => !isSeparator(item) && item.icon)
  return (
    <BottomSheet
      ref={sheet}
      onDismissed={onClose}
      handleLabel="Resize menu"
      header={
        title ? (
          <div className="flex h-9 items-center px-3">
            <span className="min-w-0 flex-1 truncate text-[17px] font-semibold leading-tight tracking-[-0.012em]">
              {title}
            </span>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4 pb-1">
        {groups.map((rows, index) => (
          <ul key={index} className="flex flex-col">
            {rows.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={item.disabled}
                  className={cn('zen-sheet-item', item.danger && 'text-[var(--zen-danger)]')}
                  onClick={() => sheet.current?.dismiss(() => item.onSelect())}
                >
                  {withIcons && (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      {item.icon && <item.icon className="h-5 w-5" strokeWidth={1.75} />}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </BottomSheet>
  )
}
