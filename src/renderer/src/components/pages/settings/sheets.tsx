import type { JSX, ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useEscape } from '@renderer/hooks/useEscape'
import { useBackSurface } from '@renderer/lib/back'
import { FrameDialogPortal, useFrameDialog } from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../../sheet/BottomSheet'
import { Field, RadioOption, SheetActions, ValidationMessage } from './blocks'
import type { ActionRow, FieldRow, ItemRow, RowGroup, SettingsRow, ValueRow } from './model'
import { findRow } from './model'
import { GroupList, type RowContext, type SheetRequest } from './rows'
import { SheetDismissContext, SheetRelayoutContext, useSheetDismiss } from './sheetContext'

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
 * its motion. The stack and the keyboard are the chassis's (`BottomSheet`, §9.22, §9.24, §11.2):
 * focus moves into a sheet as it opens (the checked option of a picker, else the first row or
 * button – a form's Cancel, since a text field would bring the keyboard up with the sheet), Tab
 * wraps inside it, the chrome behind the scrim is inert; a sheet that opens over a sheet recedes
 * the one beneath and makes it `inert`, the lower scrim fades out as the upper comes in – one
 * scrim, the top sheet's, above the page and the lower sheet alike – and when the upper leaves,
 * focus returns to the row of the lower sheet that opened it. Nothing here does any of that
 * itself; what is the surface's is Escape (a sheet under another leaves it to the one on top).
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
  under,
  ctx,
  close
}: {
  request: SheetRequest
  row: SettingsRow | null
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
      return <OptionsSheet row={row as ValueRow} under={under} close={close} />
    case 'field':
      return <FieldSheet row={row as FieldRow} under={under} close={close} />
    case 'confirm':
      return <ConfirmSheet row={row as ActionRow} under={under} close={close} />
    case 'form':
      return <FormSheet row={row as ActionRow} under={under} close={close} />
    case 'item':
      return <ItemSheet row={row as ItemRow} under={under} ctx={ctx} close={close} />
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
  /** A prompt (title, at most one paragraph, actions) opens on a title block either way (§9.23). */
  prompt?: boolean
  /** Another sheet is open over this one: Escape is that sheet's until it leaves. */
  under: boolean
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
 * hairline once the body has scrolled under it, and the chassis moves the focus into it as it
 * opens (§9.22) and back to the row that opened it when it leaves (§9.24).
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
  under,
  onClose,
  children,
  contentKey,
  sheetRef
}: SheetProps): JSX.Element {
  const titled = prompt || description !== undefined
  const own = useRef<BottomSheetHandle>(null)
  const sheet = sheetRef ?? own
  const titleId = useId()
  const dismiss = (after?: () => void): void => sheet.current?.dismiss(after)
  useFrameDialog({ onScrimPress: () => dismiss(), ownScrim: true })
  useBackSurface({
    name,
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  // Escape is the top popup's (`useEscape`, §9.24): a sheet under another – of this stack, or a
  // menulist's picker a form inside it opened – leaves the key to the one on top.
  useEscape(() => {
    if (!under) sheet.current?.dismiss()
  })
  // A body that changes height once the sheet is up (a form shows more rows, a field appears)
  // asks for its detents again through `useSheetRelayout`: the chassis measures on a new key.
  const [relayouts, setRelayouts] = useState(0)
  const relayout = useCallback((): void => setRelayouts((n) => n + 1), [])
  return (
    // The slot's child is a layer on the sheet chassis already (`data-sheet-layer`, as the
    // `BottomSheet` inside it): the host's chassis stays down for an `ownScrim` sheet and never
    // raises `data-sheet-up`, and main.css cuts the pointer from every other slot child
    // meanwhile – inherited by the whole sheet, so a tap would fall through to the host's scrim.
    <div
      className="zen-settings-sheet-layer absolute inset-0"
      data-surface="page"
      data-sheet-layer="true"
    >
      <BottomSheet
        ref={sheet}
        hosted
        onDismissed={onClose}
        contentKey={`${contentKey ?? ''}|${relayouts}`}
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
        <div className="zen-settings-sheet-body">
          {titled && (
            // The chassis's §9.23 title block (#140): padding 16, 17/600 at 22, the description
            // 15 at 69 % on the body line 4 under, 16 to what follows.
            <div className="zen-sheet-title-block">
              <h2 id={titleId}>{title}</h2>
              {description && <p>{description}</p>}
            </div>
          )}
          <SheetDismissContext.Provider value={dismiss}>
            <SheetRelayoutContext.Provider value={relayout}>
              {children}
            </SheetRelayoutContext.Provider>
          </SheetDismissContext.Provider>
        </div>
      </BottomSheet>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The five sheets
// ---------------------------------------------------------------------------

/**
 * §9.13 on a phone: the options as 44 px radio rows, the current one marked (and, by the
 * chassis, focused as the sheet opens); a pick closes it. Exported for a form that keeps a
 * value row of its own (Clear browsing data's time range) and opens its picker over itself.
 */
export function OptionsSheet({
  row,
  under,
  close
}: {
  row: ValueRow
  under: boolean
  close(): void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  return (
    <SettingsSheet
      name={`settings-options:${row.id}`}
      title={row.label}
      description={row.sheetDescription}
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

/**
 * A desktop input as a sheet: the one field (§9.12), its validation message, Cancel and Save.
 * A commit that takes time (a key tried against its API, a resolver asked a question) makes it
 * the §9.30 busy form: the field read-only with the typed value at full opacity, Save busy with
 * the spinner in place of its label, Cancel at .4; a refusal clears the field, gives it the
 * focus and shows the message under it; acceptance closes the sheet with the value still shown.
 */
function FieldSheet({
  row,
  under,
  close
}: {
  row: FieldRow
  under: boolean
  close(): void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(row.value)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = `settings-field-${row.id.replace(/[^a-z0-9-]/gi, '-')}`
  const refuse = (message: string): void => {
    setError(message)
    setValue('')
    input.current?.focus()
  }
  const save = (): void => {
    if (busy) return
    const outcome = row.onCommit(value)
    if (outcome instanceof Promise) {
      setBusy(true)
      setError(null)
      outcome
        .catch((e: unknown) => (e instanceof Error && e.message) || 'The check did not finish')
        .then((message) => {
          setBusy(false)
          if (message) refuse(message)
          else sheet.current?.dismiss()
        })
      return
    }
    if (outcome) {
      setError(outcome)
      return
    }
    sheet.current?.dismiss()
  }
  return (
    <SettingsSheet
      name={`settings-field:${row.id}`}
      title={row.label}
      under={under}
      onClose={close}
      sheetRef={sheet}
    >
      <div className="zen-settings-form" aria-busy={busy || undefined}>
        <Field id={id} label={row.label} description={error ? undefined : row.description}>
          <input
            ref={input}
            id={id}
            className={cn('zen-settings-input zen-v2-field', row.secret && 'zen-settings-secret')}
            type={row.input === 'number' ? 'number' : 'text'}
            inputMode={row.input === 'number' ? 'numeric' : 'text'}
            min={row.min}
            max={row.max}
            placeholder={row.placeholder}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            readOnly={busy}
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
        <SheetActions
          action="Save"
          busy={busy}
          onCancel={() => sheet.current?.dismiss()}
          onAction={save}
        />
      </div>
    </SettingsSheet>
  )
}

/**
 * A prompt (§9.23): the question as a title block, the destructive action trailing (§9.11);
 * Cancel, the first button, is where the chassis puts the focus as the sheet opens.
 */
function ConfirmSheet({
  row,
  under,
  close
}: {
  row: ActionRow
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
  under,
  close
}: {
  row: ActionRow
  under: boolean
  close(): void
}): JSX.Element {
  const form = row.form!
  return (
    <SettingsSheet
      name={`settings-form:${row.id}`}
      title={form.title}
      description={form.description}
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

/**
 * One thing of a list and the rows that act on it (the chassis focuses the first row as the
 * sheet opens); its value rows open the second sheet.
 */
function ItemSheet({
  row,
  under,
  ctx,
  close
}: {
  row: ItemRow
  under: boolean
  ctx: RowContext
  close(): void
}): JSX.Element {
  return (
    <SettingsSheet
      name={`settings-item:${row.id}`}
      title={row.sheet.title}
      description={row.sheet.description}
      under={under}
      onClose={close}
      contentKey={String(row.sheet.groups.reduce((n, g) => n + g.rows.length, 0))}
    >
      <GroupList groups={row.sheet.groups} ctx={ctx} className="zen-settings-sheet-rows" />
    </SettingsSheet>
  )
}
