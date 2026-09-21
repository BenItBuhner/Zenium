import type { JSX } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CircleAlert, Info } from 'lucide-react'
import type { ImportKind, ImportProgress, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import {
  IMPORT_TITLE,
  KIND_LABEL,
  kindOutcome,
  kindRows,
  limitNotes,
  outcomeLines,
  profileLabel,
  progressLine,
  reportedKinds,
  resultCaption,
  resultHeadline,
  runOutcome,
  runningNotice,
  type OutcomeState
} from '@renderer/lib/importData'
import { closeImportDialog, openOverlay, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { V2_GLYPH, V2Button } from '../v2/controls'
import {
  BusyButton,
  Checkbox,
  ChoiceRow,
  DesktopDialog,
  Footer,
  Spinner,
  TitleBlock,
  type DialogApi
} from '../siteControls/primitives'
import { ResultGlyph } from './ResultGlyph'
import { useImportForm, type ImportForm } from './useImportForm'

/**
 * Chrome's "Import bookmarks and settings" on a mouse (ID-23; design-language-v2-draft §9.5,
 * §9.11–§9.14, §9.20, §9.23, §9.30): a `--v2-dialog` through the frame dialog host at the 400
 * form width. A title block, then the form – "From" as a menulist of the browsers found on this
 * computer and the two file sources, a "Profile" menulist under it when the browser has more
 * than one, a checkbox row per kind the source holds (every one checked at first, as Chrome's),
 * a kind the source cannot give here as a disabled row whose second line is the recorded limit
 * (Chrome's CSV export as the way round), and, for a browser that is running, the line naming it
 * (Firefox's places database is refused while it runs, so Import is off for it; Chrome and Edge
 * read from a copy and keep it armed). The dialog form of footer: Cancel and the primary Import.
 * While it runs the form is busy (§9.30): the menulists and boxes read-only at full opacity,
 * Import busy, Cancel at .4, and the status line – whose slot stands blank under the rows from
 * the start, so nothing moves on the press – says which kind is being read. The result takes
 * the body: Chrome's "Your bookmarks and settings are ready" (or the failure in the danger ink –
 * a lock refusal names the browser; every kind failing names the kinds), the source, one row
 * per kind with what came in and what was skipped, the limits as rows of the same anatomy,
 * Chrome's "Show bookmarks bar" box when bookmarks came in and the bar is not always shown, and
 * Done (Show bookmarks beside it when a folder was made, Try again on a failure). Mounted by
 * `TabDialogs` while `importDialog` is set; opened from Settings > Import
 * and from Bookmarks > Import Bookmarks and Settings…. The phone has no dialog: its Settings
 * category imports from files through the builder's rows (`pages/settings/sections.tsx`).
 *
 * One text edge through the body (§10.3's principle on a dialog): the check rows put their
 * label 10 after the 16 box, so every line with a 16 glyph before it – the running line, a limit
 * note, the result's headline and rows – takes the same 10, and the glyph sits on its first
 * line by §9.2's offset, (line − glyph) / 2 from the tokens and never a written 2.
 */

/** §9.2's leading-glyph offset onto a body line: the same expression `ListRow` gives its slot. */
const GLYPH_ON_LINE = 'mt-[calc((var(--v2-line-body)-var(--v2-icon))/2)]'
/** The check row's 10 between its box and its label (`CONTROL_LABEL`, the primitives). */
const GLYPH_GAP = 'gap-2.5'
export function ImportDialog({ state }: { state: UIState }): JSX.Element | null {
  const open = uiStore.use((s) => s.importDialog)
  if (!open) return null
  return <Dialog state={state} preselect={open.source} />
}

function Dialog({ state, preselect }: { state: UIState; preselect: string | null }): JSX.Element {
  const titleId = useId()
  const api = useRef<DialogApi | null>(null)
  const form = useImportForm(state.import, preselect)
  const busy = form.phase === 'busy'
  const [scrolled, setScrolled] = useState(false)
  const [showBar, setShowBar] = useState(true)

  // Cancel, Done and Escape close through the dialog, which hands focus back to the anchor
  // (§9.22); a finished import is dismissed with it so the next open starts clean. While the
  // import works the dialog stays: nothing closes it (Chrome's is modal for the run's length).
  const leave = useCallback((): void => {
    if (!uiStore.get().importDialog) return
    const progress = form.progress
    if (progress && progress.status !== 'running') run('import.dismiss', undefined)
    closeImportDialog()
  }, [form.progress])
  const cancel = useCallback((): void => {
    if (busy) return
    leave()
  }, [busy, leave])
  const close = useCallback((): void => {
    if (api.current) api.current.close()
    else cancel()
  }, [cancel])

  const bookmarksCameIn =
    form.phase === 'result' && (form.progress?.results.bookmarks?.imported ?? 0) > 0
  const offerBar = bookmarksCameIn && state.settings.bookmarksBar !== 'always'
  // A failed run – its own failure, or every kind it reported on failing – offers Try again.
  const failedRun =
    form.phase === 'result' && form.progress !== null && runOutcome(form.progress) === 'error'
  const done = (): void => {
    if (offerBar && showBar) run('settings.update', { bookmarksBar: 'always' })
    close()
  }
  const showBookmarks = (): void => {
    const folderId = form.progress?.folderId ?? null
    close()
    void openOverlay('bookmarks', null, null, folderId)
  }

  return (
    <DesktopDialog
      labelledBy={titleId}
      onCancel={cancel}
      api={api}
      initialFocus="container"
      data-testid="import-dialog"
      data-phase={form.phase}
      data-busy={busy ? '' : undefined}
    >
      <TitleBlock
        id={titleId}
        title={IMPORT_TITLE}
        description={
          form.phase === 'result'
            ? undefined
            : 'Bring your bookmarks, browsing history and saved passwords from another browser on this computer, or from a file.'
        }
        scrolled={scrolled}
      />
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        {form.phase === 'result' && form.progress ? (
          <Result
            progress={form.progress}
            offerBar={offerBar}
            showBar={showBar}
            onShowBar={setShowBar}
          />
        ) : (
          <Body form={form} />
        )}
      </div>
      {form.phase === 'result' && form.progress ? (
        <Footer count={1 + (failedRun ? 1 : 0) + (form.progress.folderId ? 1 : 0)} hairline={false}>
          {failedRun && (
            <V2Button onClick={form.again} data-testid="import-again">
              Try again
            </V2Button>
          )}
          {form.progress.folderId && (
            <V2Button onClick={showBookmarks} data-testid="import-show-bookmarks">
              Show bookmarks
            </V2Button>
          )}
          <V2Button variant="primary" onClick={done} data-testid="import-done">
            Done
          </V2Button>
        </Footer>
      ) : (
        <Footer count={2} hairline={false}>
          <V2Button onClick={close} disabled={busy}>
            Cancel
          </V2Button>
          <BusyButton
            variant="primary"
            busy={busy}
            // Busy is not disabled (§9.30): the working primary keeps its ink under the spinner
            // and only Cancel goes to .4; `BusyButton` already drops the press while it spins.
            disabled={!busy && !canImport(form)}
            onClick={form.submit}
            data-testid="import-submit"
          >
            Import
          </BusyButton>
        </Footer>
      )}
    </DesktopDialog>
  )
}

/** Import is armed once a source with a checked kind is chosen and the source can be read. */
function canImport(form: ImportForm): boolean {
  if (form.phase !== 'form' || !form.source || form.selected.length === 0) return false
  // Firefox's places database is held while Firefox runs: the engine would refuse (the line
  // under the rows says so), so the button is off rather than the run failing.
  return !(form.source.browser === 'firefox' && form.source.running)
}

const NOTE = cn('flex items-start px-4 text-[13px] leading-5', GLYPH_GAP)
// A line with the spinner on it clips: the glyph's rotation would otherwise count as scrollable
// overflow at the body's bottom edge and put a scrollbar on the dialog for the run's length.
const SPINNER_LINE = cn(NOTE, 'overflow-hidden text-[var(--v2-text-deemphasized)]')

/** The form: the source rows, the kind boxes, the running-browser line, the busy status. */
function Body({ form }: { form: ImportForm }): JSX.Element {
  const busy = form.phase === 'busy'
  const { group, source } = form
  if (form.phase === 'loading') {
    return (
      <div className={cn(SPINNER_LINE, 'py-2')} role="status">
        <Spinner />
        <span>Looking for other browsers on this computer…</span>
      </div>
    )
  }
  const notice = runningNotice(source)
  const rows = kindRows(source)
  return (
    <>
      <ChoiceRow<string>
        label="From"
        value={group?.key ?? ''}
        options={form.groups.map((g) => ({ value: g.key, label: g.label }))}
        onChange={form.pickGroup}
        readOnly={busy}
        autoFocus
        controlClassName="zen-import-control"
      />
      {group && group.profiles.length > 1 && (
        <ChoiceRow<string>
          label="Profile"
          description={source?.email}
          value={source?.id ?? ''}
          options={group.profiles.map((p) => ({
            value: p.id,
            label: profileLabel(p, group.profiles)
          }))}
          onChange={form.pickProfile}
          readOnly={busy}
          controlClassName="zen-import-control"
        />
      )}
      {group && group.profiles.length === 1 && source?.email && (
        <p className={cn(NOTE, 'pb-1 text-[var(--v2-text-deemphasized)]')}>
          <span className="w-[var(--v2-icon)] shrink-0" aria-hidden />
          <span>{source.email}</span>
        </p>
      )}
      <div className="flex flex-col pt-1" data-testid="import-kinds" aria-busy={busy || undefined}>
        {rows.map(({ kind, available }) => (
          <KindRow
            key={kind}
            kind={kind}
            available={available}
            checked={available && form.checked.has(kind)}
            busy={busy}
            onChange={(on) => form.toggle(kind, on)}
          />
        ))}
      </div>
      {limitNotes(source).map(({ kind, text }) => (
        <LimitNote key={kind} text={text} />
      ))}
      {notice && (
        <p
          className={cn(
            NOTE,
            'pt-2',
            source?.browser === 'firefox' ? 'text-[var(--v2-danger)]' : 'text-[var(--v2-warn)]'
          )}
          role="status"
          data-testid="import-running"
        >
          <CircleAlert className={cn(V2_GLYPH, GLYPH_ON_LINE)} aria-hidden />
          <span>{notice}</span>
        </p>
      )}
      {/* The status line's slot stands from the form's first frame, blank until the run: the
          busy form keeps its fields as they are (§9.30), so the press of Import changes inks and
          glyphs only – a line that appeared on the press would grow the dialog by its 28 and the
          host would re-centre it, moving every control. Standing as a live region before it has
          words, it is read when they arrive. */}
      <p
        // 28 = the 8 above it and the 20 line, the box it fills when the words are in it.
        className={cn(SPINNER_LINE, 'min-h-7 pt-2')}
        role="status"
        data-testid="import-progress"
        data-blank={busy && form.progress ? undefined : ''}
      >
        {busy && form.progress && (
          <>
            <Spinner className={GLYPH_ON_LINE} />
            <span>{progressLine(form.progress)}</span>
          </>
        )}
      </p>
    </>
  )
}

/**
 * One kind's row: a checkbox with the kind's label. A kind the source cannot give here is the
 * same row disabled (the check row puts the .4 on its content, §9.30) – its recorded limit and
 * the way round are the `LimitNote` under the rows, since a line inside the disabled row would
 * read at .4 and the limit is the one thing the user needs to read.
 */
function KindRow({
  kind,
  available,
  checked,
  busy,
  onChange
}: {
  kind: ImportKind
  available: boolean
  checked: boolean
  busy: boolean
  onChange: (on: boolean) => void
}): JSX.Element {
  return (
    <Checkbox
      className="min-h-[var(--v2-row)] px-4 py-[calc((var(--v2-row)-20px)/2)]"
      checked={checked}
      disabled={!available}
      aria-readonly={busy || undefined}
      onChange={(e) => {
        if (!busy) onChange(e.currentTarget.checked)
      }}
      data-import-kind={kind}
      data-disabled={available ? undefined : ''}
      label={KIND_LABEL[kind]}
    />
  )
}

/**
 * A recorded limit under the form's rows (§9.12's description form: 13 at 69% after a 16 px
 * aside glyph, one ink): what the source cannot give here and the way round. The disabled row
 * above names the kind, and the sentence names it again, so the note carries no run-in label –
 * §4 has no 13 px full-ink text. In the result the same limit is a kind row (`ResultRow`).
 */
function LimitNote({ text }: { text: string }): JSX.Element {
  return (
    <p className={cn(NOTE, 'pt-2 text-[var(--v2-text-deemphasized)]')} data-testid="import-limit">
      <Info className={cn(V2_GLYPH, GLYPH_ON_LINE)} aria-hidden />
      <span>{text}</span>
    </p>
  )
}

/**
 * One kind in the result: its glyph in the status ink on the label's line, the kind's label at
 * 15, its lines at 13 – the counts at 69%, a failure's reason in the danger ink (§9.33). A kind
 * the source could not give here is the same row with the aside glyph and the recorded limit
 * as its line: the list keeps one anatomy (§4's 15 / 13 rows), not a smaller fourth row.
 */
function ResultRow({
  kind,
  state,
  lines,
  danger = false,
  limit = false
}: {
  kind: ImportKind
  state: OutcomeState
  lines: readonly string[]
  danger?: boolean
  limit?: boolean
}): JSX.Element {
  return (
    <li
      className={cn('flex items-start px-4 py-1.5', GLYPH_GAP)}
      data-import-kind={kind}
      data-testid={limit ? 'import-limit' : undefined}
    >
      <ResultGlyph state={state} className={GLYPH_ON_LINE} />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] leading-5 text-[var(--v2-text)]">{KIND_LABEL[kind]}</div>
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              'text-[13px] leading-5 [font-variant-numeric:tabular-nums]',
              danger ? 'text-[var(--v2-danger)]' : 'text-[var(--v2-text-deemphasized)]'
            )}
          >
            {line}
          </div>
        ))}
      </div>
    </li>
  )
}

/**
 * The result: the headline as the sub-heading over the kind rows (§4, §9.27: 15/600, its
 * description – the source – 15 at 69% 4 under it, the first row's box 8 below; a failure's
 * headline in the danger ink, §9.33 – the run's own failure, or every kind it reported on
 * failing), its glyph on the heading's line in the status ink, one row per kind with its lines,
 * the limits as rows of the same anatomy, and Chrome's "Show bookmarks bar" box when bookmarks
 * came in.
 */
function Result({
  progress,
  offerBar,
  showBar,
  onShowBar
}: {
  progress: ImportProgress
  offerBar: boolean
  showBar: boolean
  onShowBar: (on: boolean) => void
}): JSX.Element {
  const headingId = useId()
  const kinds = reportedKinds(progress)
  const failed = runOutcome(progress) === 'error'
  const notes = limitNotes(progress.source).filter(({ kind }) => !progress.results[kind])
  const heading = useRef<HTMLParagraphElement>(null)
  // The result arrives while the busy primary holds the focus; the headline takes it so the
  // outcome is read (§9.22), Done a Tab away.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div className="flex flex-col" data-testid="import-result" data-failed={failed || undefined}>
      <div className={cn('flex items-start px-4 pb-2', GLYPH_GAP)}>
        <ResultGlyph state={runOutcome(progress)} className={GLYPH_ON_LINE} />
        <div className="min-w-0 flex-1">
          <p
            ref={heading}
            id={headingId}
            tabIndex={-1}
            role="status"
            className={cn(
              'text-[15px] leading-5 font-semibold outline-none',
              failed ? 'text-[var(--v2-danger)]' : 'text-[var(--v2-text)]'
            )}
            data-testid="import-result-headline"
          >
            {resultHeadline(progress)}
          </p>
          <p className="mt-1 text-[15px] leading-5 text-[var(--v2-text-deemphasized)]">
            {resultCaption(progress)}
          </p>
        </div>
      </div>
      {(kinds.length > 0 || notes.length > 0) && (
        <ul className="flex flex-col" aria-labelledby={headingId}>
          {kinds.map((kind) => {
            const outcome = progress.results[kind]!
            return (
              <ResultRow
                key={kind}
                kind={kind}
                state={kindOutcome(outcome)}
                lines={outcomeLines(kind, outcome)}
                danger={Boolean(outcome.error)}
              />
            )
          })}
          {notes.map(({ kind, text }) => (
            <ResultRow key={kind} kind={kind} state="none" lines={[text]} limit />
          ))}
        </ul>
      )}
      {offerBar && (
        <Checkbox
          className="mt-2 min-h-[var(--v2-row)] px-4 py-[calc((var(--v2-row)-20px)/2)]"
          checked={showBar}
          onChange={(e) => onShowBar(e.currentTarget.checked)}
          data-testid="import-show-bar"
          label="Show bookmarks bar"
        />
      )}
    </div>
  )
}
