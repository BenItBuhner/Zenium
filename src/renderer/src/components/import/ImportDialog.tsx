import type { JSX } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CircleAlert, Info } from 'lucide-react'
import type { ImportKind, ImportProgress, ImportSource, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import {
  IMPORT_TITLE,
  KIND_LABEL,
  kindRows,
  limitNotes,
  outcomeLines,
  profileLabel,
  progressLine,
  reportedKinds,
  resultCaption,
  resultHeadline,
  runningNotice
} from '@renderer/lib/importData'
import { closeImportDialog, openOverlay, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { V2_GLYPH, V2Button } from '../v2/controls'
import { StatusGlyph } from '../siteControls/pane'
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
 * Import busy, Cancel at .4, and a status line says which kind is being read. The result takes
 * the body: Chrome's "Your bookmarks and settings are ready" (or the run's failure – a lock
 * refusal names the browser), the source, one row per kind with what came in and what was
 * skipped, the limits as an inline note, Chrome's "Show bookmarks bar" box when bookmarks came
 * in and the bar is not always shown, and Done (Show bookmarks beside it when a folder was
 * made). Mounted by `TabDialogs` while `importDialog` is set; opened from Settings > Import
 * and from Bookmarks > Import Bookmarks and Settings…. The phone has no dialog: its Settings
 * category imports from files through the builder's rows (`pages/settings/sections.tsx`).
 */
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
        <Footer count={form.progress.folderId ? 2 : 1} hairline={false}>
          {form.progress.error && (
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
            disabled={!canImport(form)}
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

const NOTE = 'flex items-start gap-2 px-4 text-[13px] leading-5'
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
        controlClassName="w-[180px]"
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
          controlClassName="w-[180px]"
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
            source={source}
            available={available}
            checked={available && form.checked.has(kind)}
            busy={busy}
            onChange={(on) => form.toggle(kind, on)}
          />
        ))}
      </div>
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
          <CircleAlert className={cn(V2_GLYPH, 'mt-0.5')} aria-hidden />
          <span>{notice}</span>
        </p>
      )}
      {busy && form.progress && (
        <p className={cn(SPINNER_LINE, 'pt-2')} role="status" data-testid="import-progress">
          <Spinner className="mt-0.5" />
          <span>{progressLine(form.progress)}</span>
        </p>
      )}
    </>
  )
}

/**
 * One kind's row: a checkbox with the kind's label; a kind the source cannot give here is one
 * disabled row (the check row puts the .4 on its content, §9.30) whose second line is the
 * recorded limit and the way round.
 */
function KindRow({
  kind,
  source,
  available,
  checked,
  busy,
  onChange
}: {
  kind: ImportKind
  source: ImportSource | null
  available: boolean
  checked: boolean
  busy: boolean
  onChange: (on: boolean) => void
}): JSX.Element {
  const limit = available ? null : (source?.limits[kind] ?? null)
  return (
    <Checkbox
      className={cn(
        'px-4',
        limit
          ? 'min-h-[var(--v2-row-two-line)] py-[calc((var(--v2-row-two-line)-40px)/2)]'
          : 'min-h-[var(--v2-row)] py-[calc((var(--v2-row)-20px)/2)]'
      )}
      checked={checked}
      disabled={!available}
      aria-readonly={busy || undefined}
      onChange={(e) => {
        if (!busy) onChange(e.currentTarget.checked)
      }}
      data-import-kind={kind}
      data-disabled={limit ? '' : undefined}
      label={
        <>
          <span className="block">{KIND_LABEL[kind]}</span>
          {limit && (
            <span className="block text-[13px] leading-5 text-[var(--v2-text-deemphasized)]">
              {limit}
            </span>
          )}
        </>
      }
    />
  )
}

/**
 * A result row's glyph on the label's line (§9.2, §1 status ink): ok for what came in, the
 * danger ink for a failure – the same ink its lines take – and the aside glyph where nothing
 * came in and nothing failed. `StatusGlyph`'s warning is the site-safety ink; a failed import
 * is an error and reads in `--v2-danger` like every other error message (§9.33).
 */
function ResultGlyph({ state }: { state: 'ok' | 'error' | 'none' }): JSX.Element {
  if (state === 'error')
    return <CircleAlert className={cn(V2_GLYPH, 'mt-0.5 text-[var(--v2-danger)]')} aria-hidden />
  return <StatusGlyph state={state === 'ok' ? 'safe' : 'info'} className="mt-0.5" />
}

/**
 * The result: the headline and the source, one row per kind with its lines, the limits as an
 * inline note, and Chrome's "Show bookmarks bar" box when bookmarks came in.
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
  const failed = Boolean(progress.error)
  const notes = limitNotes(progress.source).filter(({ kind }) => !progress.results[kind])
  const heading = useRef<HTMLParagraphElement>(null)
  // The result arrives while the busy primary holds the focus; the headline takes it so the
  // outcome is read (§9.22), Done a Tab away.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div className="flex flex-col" data-testid="import-result" data-failed={failed || undefined}>
      <div className="flex items-start gap-2 px-4 pb-2">
        <ResultGlyph
          state={
            failed ? 'error' : kinds.some((k) => progress.results[k]?.imported) ? 'ok' : 'none'
          }
        />
        <div className="min-w-0 flex-1">
          <p
            ref={heading}
            id={headingId}
            tabIndex={-1}
            role="status"
            className="text-[15px] leading-5 text-[var(--v2-text)] outline-none"
          >
            {resultHeadline(progress)}
          </p>
          <p className="text-[13px] leading-5 text-[var(--v2-text-deemphasized)]">
            {resultCaption(progress)}
          </p>
        </div>
      </div>
      {kinds.length > 0 && (
        <ul className="flex flex-col" aria-labelledby={headingId}>
          {kinds.map((kind) => {
            const outcome = progress.results[kind]!
            const lines = outcomeLines(kind, outcome)
            return (
              <li
                key={kind}
                className="flex items-start gap-2.5 px-4 py-1.5"
                data-import-kind={kind}
              >
                <ResultGlyph
                  state={outcome.error ? 'error' : outcome.imported > 0 ? 'ok' : 'none'}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] leading-5 text-[var(--v2-text)]">
                    {KIND_LABEL[kind]}
                  </div>
                  {lines.map((line, i) => (
                    <div
                      key={i}
                      className={cn(
                        'text-[13px] leading-5 [font-variant-numeric:tabular-nums]',
                        outcome.error
                          ? 'text-[var(--v2-danger)]'
                          : 'text-[var(--v2-text-deemphasized)]'
                      )}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {notes.map(({ kind, text }) => (
        <p
          key={kind}
          className={cn(NOTE, 'pt-2 text-[var(--v2-text-deemphasized)]')}
          data-testid="import-limit"
        >
          <Info className={cn(V2_GLYPH, 'mt-0.5')} aria-hidden />
          <span>
            <span className="text-[var(--v2-text)]">{KIND_LABEL[kind]}: </span>
            {text}
          </span>
        </p>
      ))}
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
