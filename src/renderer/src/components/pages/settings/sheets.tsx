import type { JSX, ReactNode, RefObject } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { useBackSurface } from '@renderer/lib/back'
import { FrameDialogPortal, useFrameDialog } from '@renderer/lib/portals'
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
 * Sheets are modal dialogs, so they mount through the frame's `FrameDialogHost` (lib/portals.tsx,
 * reached with `FrameDialogPortal`): over the content frame, which recedes under a sheet and
 * would shrink a sheet inside it. Each sheet draws its scrim itself (`ownScrim`), fading with
 * its motion; under a stacked sheet the lower one's scrim fades out on the stacked one's
 * progress, so the stack has one scrim – the top sheet's, above the page and the lower sheet
 * alike – and the page never darkens twice (§9.24); the sheet beneath recedes on the same
 * progress with its content `inert`.
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

/**
 * What takes the focus as the sheet opens (§9.22: focus moves into a dialog on open):
 *  - `checked`: the current option of a picker, the first row when none is;
 *  - `first`: the first row or button of the body (an item's rows, a prompt's Cancel);
 *  - `dialog`: the sheet itself, for a form – its field is first in the order but a text field
 *    never takes the focus on its own on a phone (the keyboard would come up with the sheet), so
 *    the dialog does, named by its title.
 */
export type SheetFocus = 'checked' | 'first' | 'dialog'

interface SheetProps {
  /** For the back registry's logs. */
  name: string
  title: string
  /** With a description the sheet opens on a §9.23 title block instead of the 48 px header. */
  description?: string
  /** A prompt (title, at most one paragraph, actions) opens on a title block either way (§9.23). */
  prompt?: boolean
  stacked: boolean
  /** Another sheet is open over this one: its content is inert until that one leaves. */
  under: boolean
  focus: SheetFocus
  onClose(): void
  children: ReactNode
  /** Change it when the body is swapped, so the detents are measured again. */
  contentKey?: string
  sheetRef?: RefObject<BottomSheetHandle | null>
}

/**
 * One v2 sheet on the shared `BottomSheet`, placed in the frame's dialog host: the chassis's
 * neutral panel at radius 12 with a hairline edge, no side padding of its own (§9.25: rows run
 * edge to edge, text inset 16), the system back and Escape dismiss it, the header takes §9.7's
 * hairline once the body has scrolled under it, focus moves into it as it opens (§9.22) and,
 * when it leaves, returns to the row that opened it (§9.24).
 */
export function SettingsSheet(props: SheetProps): JSX.Element {
  return (
    <FrameDialogPortal>
      <HostedSheet {...props} />
    </FrameDialogPortal>
  )
}

/** The sheet inside the host: registered with it as a dialog that draws its own scrim. */
function HostedSheet({
  name,
  title,
  description,
  prompt = false,
  stacked,
  under,
  focus,
  onClose,
  children,
  contentKey,
  sheetRef
}: SheetProps): JSX.Element {
  const titled = prompt || description !== undefined
  const own = useRef<BottomSheetHandle>(null)
  const sheet = sheetRef ?? own
  const body = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const dismiss = (): void => sheet.current?.dismiss()
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useBackSurface({
    name,
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useReturnFocus()
  useFocusOnOpen(body, focus)
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
  return (
    <div
      className="zen-settings-sheet-layer absolute inset-0"
      data-surface="page"
      data-under={under || undefined}
      inert={under || undefined}
    >
      <BottomSheet
        ref={sheet}
        hosted
        onDismissed={onClose}
        stacked={stacked}
        contentKey={contentKey}
        handleLabel="Resize sheet"
        labelledBy={titleId}
        className={cn('zen-settings-sheet', titled && 'zen-settings-sheet-titled')}
        header={
          titled ? undefined : (
            <h2 id={titleId} className="zen-sheet-title">
              {title}
            </h2>
          )
        }
      >
        <div ref={body} className="zen-settings-sheet-body">
          {titled && (
            <div className="zen-settings-title-block">
              <h2 id={titleId} className="zen-settings-sheet-title">
                {title}
              </h2>
              {description && <p className="zen-settings-title-description">{description}</p>}
            </div>
          )}
          <SheetDismissContext.Provider value={dismiss}>{children}</SheetDismissContext.Provider>
        </div>
      </BottomSheet>
    </div>
  )
}

/**
 * Focus returns to the row that opened the sheet once the sheet is gone (§9.24): the row is
 * what had focus as the sheet mounted. Restored after the commit that removes the sheet, so a
 * row inside the sheet beneath – `inert` until then – can take it; not restored when focus has
 * since gone somewhere else that is still on screen.
 */
function useReturnFocus(): void {
  useEffect(() => {
    const opener = document.activeElement
    return () => {
      queueMicrotask(() => {
        if (!(opener instanceof HTMLElement) || !opener.isConnected) return
        const now = document.activeElement
        if (now && now !== document.body && now.isConnected) return
        opener.focus()
      })
    }
  }, [])
}

/**
 * Focus moves into the sheet as it opens (§9.22), after {@link useReturnFocus} has noted the
 * opener: the chosen element per {@link SheetFocus}, without scrolling anything to reach it
 * (the sheet is still on its way up).
 */
function useFocusOnOpen(body: RefObject<HTMLElement | null>, focus: SheetFocus): void {
  useEffect(() => {
    const target = focusTarget(body.current, focus)
    target?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on open only
  }, [])
}

/** A row or a button: what `first` reaches for (a form's field is `dialog`'s case). */
const FOCUSABLE = 'button:not(:disabled), a[href]'

/** The element {@link SheetFocus} names inside the sheet's body, or null when there is none. */
function focusTarget(body: HTMLElement | null, focus: SheetFocus): HTMLElement | null {
  if (!body) return null
  switch (focus) {
    case 'checked':
      return (
        body.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
        body.querySelector<HTMLElement>(FOCUSABLE)
      )
    case 'first':
      return body.querySelector<HTMLElement>(FOCUSABLE)
    case 'dialog':
      return body.closest<HTMLElement>('[role="dialog"]')
  }
}

// ---------------------------------------------------------------------------
// The five sheets
// ---------------------------------------------------------------------------

/**
 * §9.13 on a phone: the options as 44 px radio rows, the current one marked and focused as the
 * sheet opens; a pick closes it.
 */
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
      focus="checked"
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
      focus="dialog"
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

/**
 * A prompt (§9.23): the question as a title block, the destructive action trailing (§9.11);
 * Cancel, the first button, takes the focus as the sheet opens.
 */
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
      prompt
      stacked={stacked}
      under={under}
      focus="first"
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
      focus="dialog"
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

/**
 * One thing of a list and the rows that act on it, the first row focused as the sheet opens;
 * its value rows open the second sheet.
 */
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
      focus="first"
      onClose={close}
      contentKey={String(row.sheet.groups.reduce((n, g) => n + g.rows.length, 0))}
    >
      <GroupList groups={row.sheet.groups} ctx={ctx} className="zen-settings-sheet-rows" />
    </SettingsSheet>
  )
}
