import type { JSX, ReactNode } from 'react'
import { Fragment, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { useBackSurface } from '@renderer/lib/back'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

export interface SheetAction {
  id: string
  label: string
  icon?: ReactNode
  /** Rendered in the danger ink, last, after the hairline (§4): closes tabs, deletes the group. */
  destructive?: boolean
  disabled?: boolean
  /** An aside at the row's end (a count), before the check of a current row. */
  trailing?: ReactNode
  /**
   * The row names where the user already is (the Spaces sheet's current space): the check at
   * its end and `aria-current`; a pick of it is a pick all the same.
   */
  current?: boolean
  /** The row's `data-testid`, where a driver reads it apart from its label. */
  testId?: string
  onPick: () => void
}

interface Props {
  title: string
  /** Optional row between the title and the actions (a colour palette, say). */
  header?: ReactNode
  actions: SheetAction[]
  onClose: () => void
}

/**
 * A short sheet of actions for something in the tab overview (a held card, a group's header):
 * the phone menu's `BottomSheet` – draggable, on the shared sheet surface under the tinted
 * scrim – with a title row and 48px rows. The destructive rows stand last, in the danger ink,
 * after a hairline (tab overview cleanup spec §4: the one form for every sheet here, the ⋯
 * sheet's hairline before Close All Tabs; a group's Delete Group and a saved group's after one
 * too) – the phone menu's `.zen-sheet-sep`, drawn before the first destructive row when rows
 * stand above it. A picked row slides the sheet away first and acts once it is gone; the system
 * back gesture pulls it down with the finger; Escape dismisses it. Drawn on the body: the
 * overview is a layer under the page bar, and a sheet inside it would be cut off by the bar.
 */
export function OverviewSheet({ title, header, actions, onClose }: Props): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()

  useBackSurface({
    name: 'overview-sheet',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        sheet.current?.dismiss()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return createPortal(
    <BottomSheet
      ref={sheet}
      onDismissed={onClose}
      contentKey={`${title}:${actions.map((a) => a.id).join('/')}`}
      handleLabel="Resize sheet"
      labelledBy={titleId}
      header={
        <h2 id={titleId} className="zen-sheet-title">
          {title}
        </h2>
      }
    >
      {header}
      <ul className="flex flex-col pb-2">
        {actions.map((action, index) => (
          <Fragment key={action.id}>
            {index > 0 && action.destructive && !actions[index - 1]!.destructive && (
              <li aria-hidden className="zen-sheet-sep" data-testid="overview-sheet-sep" />
            )}
            <li>
              <button
                type="button"
                disabled={!!action.disabled}
                className="zen-sheet-item"
                style={action.destructive ? { color: 'var(--zen-danger)' } : undefined}
                aria-current={action.current || undefined}
                data-testid={action.testId}
                onClick={() => sheet.current?.dismiss(() => action.onPick())}
              >
                {action.icon && (
                  <span className="flex w-5 shrink-0 items-center justify-center">
                    {action.icon}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                {action.trailing && (
                  <span className="shrink-0 text-[13px] tabular-nums text-[var(--zen-muted)]">
                    {action.trailing}
                  </span>
                )}
                {action.current && (
                  // A trailing indicator: 16 on both platforms (§9.3).
                  <Check className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden data-check="" />
                )}
              </button>
            </li>
          </Fragment>
        ))}
      </ul>
    </BottomSheet>,
    document.body
  )
}
