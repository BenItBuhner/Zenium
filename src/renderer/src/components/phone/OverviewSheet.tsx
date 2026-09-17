import type { JSX, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useBackDismissal } from '@renderer/lib/back'
import { SPRING_GENTLE } from '@renderer/lib/motion/spring'
import { uiStore } from '@renderer/lib/ui'

export interface SheetAction {
  id: string
  label: string
  icon?: ReactNode
  /** Rendered in the danger ink: closes tabs. */
  destructive?: boolean
  disabled?: boolean
  onPick: () => void
}

interface Props {
  title: string
  /** Optional row between the title and the actions (a colour palette, say). */
  header?: ReactNode
  actions: SheetAction[]
  onClose: () => void
}

/** How far the sheet hangs below the screen, so a spring overshoot never shows its bottom edge. */
const UNDERHANG = 48

/**
 * A short sheet of actions for something in the tab overview (a held card, a group's header),
 * on the chrome's shared sheet surface (`.zen-sheet`): grabber, 56px title row, 48px rows that
 * nest concentrically inside the sheet's corner, under the space-tinted scrim. A tap on the
 * scrim or Escape puts it away; the system back gesture slides it down with the finger through
 * the back-surface registry.
 *
 * Structure mirrors the phone menu's `BottomSheet` (title row as `header`, rows as children) so
 * it can move onto that primitive – drag, detents – once it lands.
 */
export function OverviewSheet({ title, header, actions, onClose }: Props): JSX.Element {
  const insets = uiStore.use((s) => s.insets)
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  // The sheet appears under a finger that is still lifting off a card: the click that follows
  // that touch lands on the scrim and must not close what it just opened. Only a touch that
  // began on the scrim dismisses it.
  const armed = useRef(false)

  // Predictive back: the sheet follows the gesture down and its scrim thins with it.
  useBackDismissal('overview-sheet', {
    travel: 320,
    spring: SPRING_GENTLE,
    render: (v) => {
      const sheet = sheetRef.current
      const scrim = scrimRef.current
      if (sheet) sheet.style.transform = `translateY(${v * 100}%)`
      if (scrim) scrim.style.opacity = `${1 - v}`
    },
    dismissed: onClose
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Portalled out of the gesture stage's stacking context so it covers the bottom bar too.
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col justify-end"
      onPointerDown={(e) => {
        armed.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && armed.current) onClose()
      }}
    >
      <div
        ref={scrimRef}
        className="zen-overview-scrim zen-animate-fade pointer-events-none absolute inset-0"
      />
      <div
        ref={sheetRef}
        className="zen-sheet zen-sheet-in relative mx-auto flex w-full max-w-[520px] flex-col pt-2"
        style={{
          marginBottom: -UNDERHANG,
          paddingBottom: UNDERHANG + Math.max(12, insets.bottom + 4)
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto h-1 w-8 rounded-full bg-[rgb(var(--zen-fg-rgb)/0.25)]" />
        <div className="flex h-14 items-center px-3">
          <span className="zen-title min-w-0 flex-1 truncate">{title}</span>
        </div>
        {header}
        <ul className="flex flex-col">
          {actions.map((action) => (
            <li key={action.id}>
              <button
                type="button"
                disabled={!!action.disabled}
                data-danger={action.destructive || undefined}
                className="zen-overview-sheet-row flex h-12 w-full items-center gap-3 px-3 text-left text-[14px] disabled:opacity-40"
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
