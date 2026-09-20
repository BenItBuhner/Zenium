import type { ImportKind, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import {
  FILE_SOURCE,
  KIND_LABEL,
  finishedImport,
  outcomeLines,
  reportedKinds,
  resultCaption,
  resultHeadline
} from '@renderer/lib/importData'
import { openOverlay } from '@renderer/lib/ui'
import type { RowGroup, SettingsRow } from '../pages/settings/model'
import { StatusGlyph } from '../siteControls/pane'

/**
 * Settings > Import on a phone (design-language-v2-draft §10.4, §9.30): Android has no other
 * browser's profile to read, so the category is two action rows over `dialog.openText` – a
 * bookmarks HTML file, a passwords CSV file where the host has a vault – each busy while its
 * import runs (the row keeps its ink, trails the spinner, takes no press), and the last
 * import's result as a group under them until it is dismissed: the headline (Chrome's "Your
 * bookmarks and settings are ready", or the failure), one row per kind with what came in and
 * what was skipped, Show imported bookmarks when a folder was made, and Dismiss. The desktop's
 * form of the category is `overlays/ImportSection` with the dialog.
 */
export function importGroups(state: UIState, tabId: string | null): RowGroup[] {
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
      keywords: ['html', 'netscape', 'favorites', 'chrome', 'edge', 'firefox', 'safari'],
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
      keywords: [
        'csv',
        'chrome',
        'edge',
        'firefox',
        'safari',
        'bitwarden',
        'lastpass',
        '1password'
      ],
      busy: running === FILE_SOURCE.passwords,
      disabled: running !== null && running !== FILE_SOURCE.passwords,
      onPress: () => start(FILE_SOURCE.passwords, 'passwords')
    })
  const groups: RowGroup[] = [
    {
      id: 'import-files',
      heading: 'Import from a file',
      description:
        'Bring what you kept in another browser into Zenium. Export it there first, then choose the file here.',
      rows
    }
  ]
  const last = finishedImport(progress)
  if (last) {
    const kinds = reportedKinds(last)
    const failed = Boolean(last.error)
    const result: SettingsRow[] = [
      {
        kind: 'info',
        id: 'import-last-headline',
        label: resultHeadline(last),
        description: resultCaption(last),
        tone: failed ? 'danger' : undefined,
        leading: (
          <StatusGlyph
            state={
              failed ? 'warning' : kinds.some((k) => last.results[k]?.imported) ? 'safe' : 'info'
            }
          />
        ),
        clamp: true
      },
      ...kinds.map((kind): SettingsRow => {
        const outcome = last.results[kind]!
        return {
          kind: 'info',
          id: `import-last-${kind}`,
          label: KIND_LABEL[kind],
          description: outcomeLines(kind, outcome).join('. '),
          tone: outcome.error ? 'danger' : undefined,
          leading: (
            <StatusGlyph
              state={outcome.error ? 'warning' : outcome.imported > 0 ? 'safe' : 'info'}
            />
          )
        }
      })
    ]
    if (last.folderId) {
      const folderId = last.folderId
      result.push({
        kind: 'action',
        id: 'import-last-show',
        label: 'Show imported bookmarks',
        leaves: 'chevron',
        onPress: () => void openOverlay('bookmarks', tabId, null, folderId)
      })
    }
    result.push({
      kind: 'action',
      id: 'import-last-dismiss',
      label: 'Dismiss',
      onPress: () => run('import.dismiss', undefined)
    })
    groups.push({ id: 'import-last', heading: 'Last import', rows: result })
  }
  return groups
}
