import type { JSX } from 'react'
import { Check, CircleAlert } from 'lucide-react'
import type { FormFactor, ImportKind, ImportProgress, ImportSource, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import {
  FILE_SOURCE,
  KIND_LABEL,
  LINE_JOINER,
  browserSources,
  finishedImport,
  kindOutcome,
  lastImportLine,
  listNames,
  outcomeLines,
  reportedKinds,
  resultCaption,
  resultHeadline,
  runOutcome,
  sourceGroups,
  type OutcomeState
} from '@renderer/lib/importData'
import { openImportDialog, openOverlay } from '@renderer/lib/ui'
import type { RowGroup, SettingsRow } from '../pages/settings/model'
import type { SectionContext } from '../pages/settings/sections'
import { V2Button } from '../v2/controls'
import { ResultGlyph } from './ResultGlyph'

/**
 * Settings › Import (Chrome's `chrome://settings/importData`, ID-23) on the shared Settings
 * builder, in the two shells' rows (design-language-v2-draft §10.4, §10.5, §9.30):
 *
 * On a mouse the category is a pane that leads to the dialog (`import/ImportDialog`, mounted by
 * `TabDialogs` through the frame dialog host over the Settings tab): "Import from another
 * browser" names the browsers found on this computer (`ctx.importSources`, read while the
 * category is shown) and trails a hugging Import… button on its row (§9.21); "Import from a
 * file" leads to the same dialog on its file sources. An import that finished while the dialog
 * was away shows as one Last import row until it is dismissed – the headline, the source and the
 * counts on one line, its glyph and ink the dialog's (`ResultGlyph`: a failure in the danger ink
 * on glyph and label alike, §9.33), Dismiss trailing. The glyph trails, before Dismiss: a status
 * glyph leads only where every row of its list carries one (the Safety Check rows), and this
 * row stands alone in a pane whose every other label sits on the one text edge – a leading
 * glyph would indent its label 26 past them, the ragged edge §10.3 forbids (§9.33).
 *
 * On a phone Android has no other browser's profile to read, so the category is two action
 * rows over `dialog.openText` – a bookmarks HTML file, a passwords CSV file where the host has
 * a vault – each busy while its import runs (the row keeps its ink, trails the spinner, takes no
 * press), and the last import's result as a group under them until it is dismissed: the
 * headline (Chrome's "Your bookmarks and settings are ready", or the failure), one row per kind
 * with what came in and what was skipped, Show imported bookmarks when a folder was made, and
 * Dismiss. The result rows tell their outcome with a trailing 16 px glyph in the §1 status ink,
 * as the Updates rows do ("Verified"): trailing rather than leading because the group's action
 * rows have no leading slot, and §10.4 keeps one left edge for the labels of a list. A row with
 * nothing to tell (nothing came in, nothing failed) carries no glyph. The states are the
 * desktop's (`runOutcome`, `kindOutcome`), so a failure reads in one ink on both platforms –
 * and on the line that is the failure: the headline row's label when the run failed (the row's
 * `danger`, as the dialog's headline), a kind row's description when that kind did (its `tone`).
 *
 * Each row and group says which shell it belongs to (`layouts`); `buildSection` keeps the
 * shell's own, so the phone's file rows never reach a desktop's page or its search, and the
 * pane's dialog rows never a phone's.
 */
const MOUSE: readonly FormFactor[] = ['desktop', 'tablet']
const PHONE: readonly FormFactor[] = ['phone']

const BROWSER_KEYWORDS = ['chrome', 'chromium', 'edge', 'firefox', 'safari', 'other browser']

export function importGroups(ctx: SectionContext): RowGroup[] {
  const { state, tab } = ctx
  const groups: RowGroup[] = [browserGroup(ctx), fileDialogGroup(tab.id), fileRowsGroup(state)]
  const last = finishedImport(state.import)
  if (last) groups.push(lastImportGroup(last, tab.id))
  return groups
}

/**
 * The pane's first line under its heading: what the engine found. It looks while the answer is
 * out, names the browsers when there are some (§9.1's Title Case names, one sentence), and says
 * so when there are none – the dialog still opens on its file sources.
 */
export function foundLine(sources: readonly ImportSource[] | null | undefined): string {
  if (sources === null || sources === undefined)
    return 'Looking for other browsers on this computer…'
  const browsers = sourceGroups(browserSources(sources))
  if (browsers.length === 0) return 'No other browsers were found on this computer.'
  return `Found on this computer: ${listNames(browsers.map((g) => g.label))}.`
}

/** "Import from another browser" (a mouse): the browsers found and the way to the dialog. */
function browserGroup({ tab, importSources }: SectionContext): RowGroup {
  return {
    id: 'import-browsers',
    heading: 'Import from another browser',
    description: foundLine(importSources),
    layouts: MOUSE,
    rows: [
      {
        kind: 'action',
        id: 'import-browser',
        label: 'Bookmarks, history and passwords',
        description: 'From Google Chrome, Chromium, Microsoft Edge, Firefox or Safari',
        keywords: [...BROWSER_KEYWORDS, 'history', 'passwords', 'transfer', 'migrate'],
        button: 'Import…',
        onPress: () => void openImportDialog(tab.id)
      }
    ]
  }
}

/** "Import from a file" (a mouse): the dialog on its file sources. */
function fileDialogGroup(tabId: string): RowGroup {
  return {
    id: 'import-file',
    heading: 'Import from a file',
    description:
      'A bookmarks HTML file, or a passwords CSV file exported from a browser or a password manager.',
    layouts: MOUSE,
    rows: [
      {
        kind: 'action',
        id: 'import-file-dialog',
        label: 'Bookmarks HTML or passwords CSV',
        description: 'Choose the file in the import dialog',
        keywords: ['html', 'csv', 'netscape', 'favorites', 'bitwarden', 'lastpass', '1password'],
        button: 'Import file…',
        onPress: () => void openImportDialog(tabId, FILE_SOURCE.bookmarks)
      }
    ]
  }
}

/** "Import from a file" (a phone): the two file imports over `dialog.openText`. */
function fileRowsGroup(state: UIState): RowGroup {
  const progress = state.import
  const running = progress?.status === 'running' ? progress.source.id : null
  const start = (source: string, kind: ImportKind): void => {
    if (running) return
    run('import.run', { source, kinds: [kind] })
  }
  const rows: SettingsRow[] = [
    {
      kind: 'action',
      id: 'import-bookmarks-file',
      label: 'Import bookmarks from a file',
      description: 'A bookmarks HTML file exported from Chrome, Edge, Firefox or Safari',
      keywords: ['html', 'netscape', 'favorites', ...BROWSER_KEYWORDS],
      busy: running === FILE_SOURCE.bookmarks,
      disabled: running !== null && running !== FILE_SOURCE.bookmarks,
      onPress: () => start(FILE_SOURCE.bookmarks, 'bookmarks')
    }
  ]
  if (state.capabilities.passwords)
    rows.push({
      kind: 'action',
      id: 'import-passwords-file',
      label: 'Import passwords from a file',
      description: 'A CSV file exported from a browser or a password manager',
      keywords: ['csv', ...BROWSER_KEYWORDS, 'bitwarden', 'lastpass', '1password'],
      busy: running === FILE_SOURCE.passwords,
      disabled: running !== null && running !== FILE_SOURCE.passwords,
      onPress: () => start(FILE_SOURCE.passwords, 'passwords')
    })
  return {
    id: 'import-files',
    heading: 'Import from a file',
    description:
      'Bring what you kept in another browser into Zenium. Export it there first, then choose the file here.',
    layouts: PHONE,
    rows
  }
}

/**
 * "Last import": on a mouse the one row the pane keeps (headline, the source and counts on one
 * line, the glyph and Dismiss trailing); on a phone the headline row, a row per kind, Show
 * imported bookmarks for the folder made, Dismiss. One group, so the heading and its id are the
 * same on both shells; `buildSection` keeps the shell's rows.
 */
function lastImportGroup(last: ImportProgress, tabId: string): RowGroup {
  const outcome = runOutcome(last)
  const dismiss = (): void => run('import.dismiss', undefined)
  const rows: SettingsRow[] = [
    {
      kind: 'info',
      id: 'import-last-summary',
      label: resultHeadline(last),
      description: lastImportLine(last),
      danger: outcome === 'error',
      clamp: true,
      layouts: MOUSE,
      trailing: (
        <>
          <ResultGlyph state={outcome} />
          <V2Button onClick={dismiss} data-testid="import-dismiss-last">
            Dismiss
          </V2Button>
        </>
      )
    },
    {
      kind: 'info',
      id: 'import-last-headline',
      label: resultHeadline(last),
      description: resultCaption(last),
      danger: outcome === 'error',
      trailing: outcomeGlyph(outcome),
      clamp: true,
      layouts: PHONE
    },
    ...reportedKinds(last).map((kind): SettingsRow => {
      const kindResult = last.results[kind]!
      return {
        kind: 'info',
        id: `import-last-${kind}`,
        label: KIND_LABEL[kind],
        description: outcomeLines(kind, kindResult).join(LINE_JOINER),
        tone: kindResult.error ? 'danger' : undefined,
        trailing: outcomeGlyph(kindOutcome(kindResult)),
        layouts: PHONE
      }
    })
  ]
  if (last.folderId) {
    const folderId = last.folderId
    rows.push({
      kind: 'action',
      id: 'import-last-show',
      label: 'Show imported bookmarks',
      leaves: 'chevron',
      layouts: PHONE,
      onPress: () => void openOverlay('bookmarks', tabId, null, folderId)
    })
  }
  rows.push({
    kind: 'action',
    id: 'import-last-dismiss',
    label: 'Dismiss',
    layouts: PHONE,
    onPress: dismiss
  })
  return { id: 'import-last', heading: 'Last import', rows }
}

/** The phone result rows' trailing glyph: ok, a failure, or nothing to tell. */
function outcomeGlyph(state: OutcomeState): JSX.Element | undefined {
  if (state === 'ok')
    return <Check className="zen-settings-trailing-glyph zen-settings-ok" aria-label="Imported" />
  if (state === 'error')
    return (
      <CircleAlert
        className="zen-settings-trailing-glyph zen-settings-danger"
        aria-label="Failed"
      />
    )
  return undefined
}
