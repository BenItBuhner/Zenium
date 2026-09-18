import type { JSX, ReactNode, RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBackSurface } from '@renderer/lib/back'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../../sheet/BottomSheet'
import { Field, RadioOption, SheetActions, ValidationMessage } from './blocks'
import type { ActionRow, FieldRow, ItemRow, RowGroup, SettingsRow, ValueRow } from './model'
import { findRow } from './model'
import { GroupList, type RowContext, type SheetRequest } from './rows'
import { SheetDismissContext, useSheetDismiss } from './sheetContext'

/**
 * The sheets a phone Settings row opens (v2 §9.13, §9.23–9.25, §10.4): a value row's picker, a
 * field row's one-field form, a destructive action's confirmation, an action's small form and an
 * item's rows. The page keeps a stack of at most two requests (§9.24: a sheet may open one sheet,
 * and that one opens nothing) and resolves each to its row again on every render, so a sheet
 * always shows the row's current value and closes by itself when its row is gone.
 *
 * Sheets mount through a portal on `document.body`: the content frame they would otherwise sit
 * in recedes (scales) under a sheet, and a sheet inside it would shrink with the page.
 */

/** Every open sheet, lowest first; each resolves its row in `groups`. */
export function SheetStack({
  requests,
  groups,
  ctx,
  closeTop
}: {
  requests: readonly SheetRequest[]
  groups: readonly RowGroup[]
  ctx: RowContext
  closeTop(): void
}): JSX.Element | null {
  if (requests.length === 0) return null
  return (
    <>
      {requests.map((request, index) => {
        const row = findRow(groups, request.rowId)
        const top = index === requests.length - 1
        return (
          <RowSheet
            key={`${request.kind}:${request.rowId}`}
            request={request}
            row={row}
            stacked={index > 0}
            under={!top}
            ctx={ctx}
            close={closeTop}
          />
        )
      })}
    </>
  )
}

function RowSheet({
  request,
  row,
  stacked,
  under,
  ctx,
  close
}: {
  request: SheetRequest
  row: SettingsRow | null
  stacked: boolean
  under: boolean
  ctx: RowContext
  close(): void
}): JSX.Element | null {
  // The row a sheet was opened for is gone (its item was deleted, its list changed): the sheet
  // has nothing to show and leaves.
  const orphan = row === null || !fits(request, row)
  useEffect(() => {
    if (orphan) close()
  }, [orphan, close])
  if (orphan) return null
  switch (request.kind) {
    case 'options':
      return <OptionsSheet row={row as ValueRow} stacked={stacked} under={under} close={close} />
    case 'field':
      return <FieldSheet row={row as FieldRow} stacked={stacked} under={under} close={close} />
    case 'confirm':
      return <ConfirmSheet row={row as ActionRow} stacked={stacked} under={under} close={close} />
    case 'form':
      return <FormSheet row={row as ActionRow} stacked={stacked} under={under} close={close} />
    case 'item':
      return (
        <ItemSheet row={row as ItemRow} stacked={stacked} under={under} ctx={ctx} close={close} />
      )
  }
}

function fits(request: SheetRequest, row: SettingsRow): boolean {
  switch (request.kind) {
    case 'options':
      return row.kind === 'value'
    case 'field':
      return row.kind === 'field'
    case 'confirm':
      return row.kind === 'action' && row.confirm !== undefined
    case 'form':
      return row.kind === 'action' && row.form !== undefined
    case 'item':
      return row.kind === 'item'
  }
}

// ---------------------------------------------------------------------------
// The sheet chassis
// ---------------------------------------------------------------------------

interface SheetProps {
  /** For the back registry's logs. */
  name: string
  title: string
  /** With a description the sheet opens on a §9.23 title block instead of the 48 px header. */
  description?: string
  stacked: boolean
  /** Another sheet is open over this one: its content is inert until that one leaves. */
  under: boolean
  onClose(): void
  children: ReactNode
  /** Change it when the body is swapped, so the detents are measured again. */
  contentKey?: string
  sheetRef?: RefObject<BottomSheetHandle | null>
}

/**
 * One v2 sheet on the shared `BottomSheet`: neutral panel at radius 12 with a hairline edge, no
 * side padding of its own (§9.25: rows run edge to edge, text inset 16), the system back and
 * Escape dismiss it, and the header takes §9.7's hairline once the body has scrolled under it.
 */
export function SettingsSheet({
  name,
  title,
  description,
  stacked,
  under,
  onClose,
  children,
  contentKey,
  sheetRef
}: SheetProps): JSX.Element {
  const own = useRef<BottomSheetHandle>(null)
  const sheet = sheetRef ?? own
  const body = useRef<HTMLDivElement>(null)
  const dismiss = (): void => sheet.current?.dismiss()
  useBackSurface({
    name,
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEffect(() => {
    if (under) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      sheet.current?.dismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [under, sheet])
  useEffect(() => {
    const scroller = body.current?.closest<HTMLElement>('.zen-sheet-scroll')
    const sheetEl = scroller?.closest<HTMLElement>('.zen-sheet')
    if (!scroller || !sheetEl) return
    const sync = (): void => {
      sheetEl.dataset.scrolled = String(scroller.scrollTop > 0)
    }
    sync()
    scroller.addEventListener('scroll', sync, { passive: true })
    return () => scroller.removeEventListener('scroll', sync)
  }, [])
  return createPortal(
    <div inert={under || undefined}>
      <BottomSheet
        ref={sheet}
        onDismissed={onClose}
        stacked={stacked}
        contentKey={contentKey}
        handleLabel="Resize sheet"
        className={cn('zen-settings-sheet', description && 'zen-settings-sheet-titled')}
        header={
          description ? undefined : (
            <div className="zen-settings-sheet-header">
              <h2 className="zen-settings-sheet-title">{title}</h2>
            </div>
          )
        }
      >
        <div ref={body} className="zen-settings-sheet-body">
          {description && (
            <div className="zen-settings-title-block">
              <h2 className="zen-settings-sheet-title">{title}</h2>
              <p className="zen-settings-title-description">{description}</p>
            </div>
          )}
          <SheetDismissContext.Provider value={dismiss}>{children}</SheetDismissContext.Provider>
        </div>
      </BottomSheet>
    </div>,
    document.body
  )
}

// ---------------------------------------------------------------------------
// The five sheets
// ---------------------------------------------------------------------------

/** §9.13 on a phone: the options as 44 px radio rows, the current one marked; a pick closes it. */
function OptionsSheet({
  row,
  stacked,
  under,
  close
}: {
  row: ValueRow
  stacked: boolean
  under: boolean
  close(): void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  return (
    <SettingsSheet
      name={`settings-options:${row.id}`}
      title={row.label}
      description={row.sheetDescription}
      stacked={stacked}
      under={under}
      onClose={close}
      sheetRef={sheet}
    >
      <div role="radiogroup" aria-label={row.label} className="zen-settings-sheet-rows">
        {row.options.map((option) => (
          <RadioOption
            key={option.value}
            label={option.label}
            description={option.description}
            checked={option.value === row.value}
            onSelect={() => {
              if (option.value !== row.value) row.onChange(option.value)
              sheet.current?.dismiss()
            }}
          />
        ))}
      </div>
    </SettingsSheet>
  )
}

/** A desktop input as a sheet: the one field (§9.12), its validation message, Cancel and Save. */
function FieldSheet({
  row,
  stacked,
  under,
  close
}: {
  row: FieldRow
  stacked: boolean
  under: boolean
  close(): void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const [value, setValue] = useState(row.value)
  const [error, setError] = useState<string | null>(null)
  const id = `settings-field-${row.id.replace(/[^a-z0-9-]/gi, '-')}`
  const save = (): void => {
    const message = row.onCommit(value)
    if (message) {
      setError(message)
      return
    }
    sheet.current?.dismiss()
  }
  return (
    <SettingsSheet
      name={`settings-field:${row.id}`}
      title={row.label}
      stacked={stacked}
      under={under}
      onClose={close}
      sheetRef={sheet}
    >
      <div className="zen-settings-form">
        <Field id={id} label={row.label} description={error ? undefined : row.description}>
          <input
            id={id}
            className="zen-settings-input zen-v2-field"
            type={row.input === 'number' ? 'number' : 'text'}
            inputMode={row.input === 'number' ? 'numeric' : 'text'}
            min={row.min}
            max={row.max}
            placeholder={row.placeholder}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
          {error && <ValidationMessage message={error} />}
        </Field>
        <SheetActions action="Save" onCancel={() => sheet.current?.dismiss()} onAction={save} />
      </div>
    </SettingsSheet>
  )
}

/** A prompt (§9.23): the question as a title block, the destructive action trailing (§9.11). */
function ConfirmSheet({
  row,
  stacked,
  under,
  close
}: {
  row: ActionRow
  stacked: boolean
  under: boolean
  close(): void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const confirm = row.confirm!
  return (
    <SettingsSheet
      name={`settings-confirm:${row.id}`}
      title={confirm.title}
      description={confirm.description ?? row.description}
      stacked={stacked}
      under={under}
      onClose={close}
      sheetRef={sheet}
    >
      <SheetActions
        action={confirm.action}
        destructive={row.destructive}
        onCancel={() => sheet.current?.dismiss()}
        onAction={() => sheet.current?.dismiss(() => row.onPress?.())}
      />
    </SettingsSheet>
  )
}

/** A small form (add a route, create a container): the form draws its own footer. */
function FormSheet({
  row,
  stacked,
  under,
  close
}: {
  row: ActionRow
  stacked: boolean
  under: boolean
  close(): void
}): JSX.Element {
  const form = row.form!
  return (
    <SettingsSheet
      name={`settings-form:${row.id}`}
      title={form.title}
      description={form.description}
      stacked={stacked}
      under={under}
      onClose={close}
    >
      <FormBody render={form.render} />
    </SettingsSheet>
  )
}

/** The form's element, given the sheet's own dismiss as its `close`. */
function FormBody({ render }: { render: (close: () => void) => ReactNode }): JSX.Element {
  const dismiss = useSheetDismiss()
  return <>{render(dismiss)}</>
}

/** One thing of a list and the rows that act on it; its value rows open the second sheet. */
function ItemSheet({
  row,
  stacked,
  under,
  ctx,
  close
}: {
  row: ItemRow
  stacked: boolean
  under: boolean
  ctx: RowContext
  close(): void
}): JSX.Element {
  return (
    <SettingsSheet
      name={`settings-item:${row.id}`}
      title={row.sheet.title}
      description={row.sheet.description}
      stacked={stacked}
      under={under}
      onClose={close}
      contentKey={String(row.sheet.groups.reduce((n, g) => n + g.rows.length, 0))}
    >
      <GroupList groups={row.sheet.groups} ctx={ctx} className="zen-settings-sheet-rows" />
    </SettingsSheet>
  )
}
