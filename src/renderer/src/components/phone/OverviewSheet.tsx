import type { JSX, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { registerBackHandler, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'

export interface SheetAction {
  id: string
  label: string
  icon?: ReactNode
  /** Rendered in red: closes tabs. */
  destructive?: boolean
  disabled?: boolean
  onPick: () => void
}

interface Props {
  title: string
  /** Optional row above the actions (a colour palette, say). */
  header?: ReactNode
  actions: SheetAction[]
  onClose: () => void
}

/**
 * A short sheet of actions for something in the tab overview (a held card, a group's header).
 * Sits at the bottom of the screen where the thumb is; a tap outside, the system back or
 * Escape puts it away. Rows are spaced, not ruled.
 */
export function OverviewSheet({ title, header, actions, onClose }: Props): JSX.Element {
  const insets = uiStore.use((s) => s.insets)
  // The sheet appears under a finger that is still lifting off a card: the click that follows
  // that touch lands on the scrim and must not close what it just opened. Only a touch that
  // began on the scrim dismisses it.
  const armed = useRef(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    const unregister = registerBackHandler(() => {
      onClose()
      return true
    })
    return () => {
      window.removeEventListener('keydown', onKey, true)
      unregister()
    }
  }, [onClose])

  // Portalled out of the gesture stage's stacking context so it covers the bottom bar too.
  return createPortal(
    <div
      className="zen-animate-fade fixed inset-0 z-[60] flex flex-col justify-end bg-black/30"
      onPointerDown={(e) => {
        armed.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && armed.current) onClose()
      }}
    >
      <div
        className="zen-sheet zen-sheet-in mx-auto w-full max-w-[520px] px-2 pt-2"
        style={{ paddingBottom: Math.max(10, insets.bottom + 4) }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-10 items-center px-3 text-[13px] font-semibold">
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </div>
        {header}
        <ul className="flex flex-col gap-0.5">
          {actions.map((action) => (
            <li key={action.id}>
              <button
                type="button"
                disabled={action.disabled}
                className={cn(
                  'zen-sheet-row flex h-12 w-full items-center gap-3 px-3 text-left text-[14px]',
                  'active:bg-[var(--zen-element-bg-hover)] disabled:opacity-40',
                  action.destructive && 'text-red-500'
                )}
                onClick={() => {
                  onClose()
                  action.onPick()
                }}
              >
                {action.icon && (
                  <span className="flex w-5 shrink-0 items-center justify-center">
                    {action.icon}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body
  )
}
