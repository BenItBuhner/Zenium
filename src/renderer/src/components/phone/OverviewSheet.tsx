import type { JSX, ReactNode } from 'react'
import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useBackSurface } from '@renderer/lib/back'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

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

/**
 * A short sheet of actions for something in the tab overview (a held card, a group's header):
 * the phone menu's `BottomSheet` – draggable, on the shared sheet surface under the tinted
 * scrim – with a title row and 48px rows. A picked row slides the sheet away first and acts
 * once it is gone; the system back gesture pulls it down with the finger; Escape dismisses it.
 * Drawn on the body: the overview is a layer under the page bar, and a sheet inside it would be
 * cut off by the bar.
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
      <ul className="flex flex-col pb-1">
        {actions.map((action) => (
          <li key={action.id}>
            <button
              type="button"
              disabled={!!action.disabled}
              className="zen-sheet-item"
              style={action.destructive ? { color: 'var(--zen-danger)' } : undefined}
              onClick={() => sheet.current?.dismiss(() => action.onPick())}
            >
              {action.icon && (
                <span className="flex w-5 shrink-0 items-center justify-center">{action.icon}</span>
              )}
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </BottomSheet>,
    document.body
  )
}
