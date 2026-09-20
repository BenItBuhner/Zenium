import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { ImportSource, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import {
  FILE_SOURCE,
  browserSources,
  finishedImport,
  listNames,
  resultCaption,
  resultHeadline,
  sourceGroups,
  summaryLine
} from '@renderer/lib/importData'
import { activeTab } from '@renderer/lib/selectors'
import { openImportDialog } from '@renderer/lib/ui'
import { V2Button } from '../v2/controls'
import { Group, Pane, Rows, StatusGlyph } from '../siteControls/pane'
import { ListRow } from '../siteControls/primitives'

/**
 * Settings > Import on a mouse (Chrome's `chrome://settings/importData`; design-language-v2-draft
 * §9.21, §9.26): the pane names the browsers found on this computer and leads to the dialog with
 * a hugging button trailing its row; a second row leads to the same dialog on its file sources.
 * The dialog itself is `import/ImportDialog`, mounted by `TabDialogs` so it renders through the
 * frame dialog host over Settings. An import that finished while the dialog was away (or that
 * a phone's rows ran) shows as the last import's row until it is dismissed. The phone's category
 * is the Settings builder's (`pages/settings/sections.tsx`, `importSection`): files only.
 */
export function ImportSection({ state }: { state: UIState }): JSX.Element {
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  useEffect(() => {
    let live = true
    void cmd('import.sources', undefined).then((found) => {
      if (live) setSources(found ?? [])
    })
    return () => {
      live = false
    }
  }, [])
  const open = (source: string | null = null): void =>
    void openImportDialog(activeTab(state)?.id ?? null, source)
  const browsers = sources ? sourceGroups(browserSources(sources)) : null
  const found =
    browsers === null
      ? 'Looking for other browsers on this computer…'
      : browsers.length === 0
        ? 'No other browsers were found on this computer.'
        : `Found on this computer: ${listNames(browsers.map((g) => g.label))}.`
  const last = finishedImport(state.import)
  return (
    <Pane
      title="Import"
      description="Bring your bookmarks, browsing history and saved passwords into Zenium from another browser on this computer, or from a file another browser exported."
      data-testid="import-section"
    >
      <Group heading="Import from another browser" description={found}>
        <Rows>
          <ListRow
            label="Bookmarks, history and passwords"
            description="From Google Chrome, Chromium, Microsoft Edge, Firefox or Safari"
            control
            trailing={
              <V2Button onClick={() => open()} data-testid="open-import-dialog">
                Import…
              </V2Button>
            }
          />
        </Rows>
      </Group>
      <Group
        heading="Import from a file"
        description="A bookmarks HTML file, or a passwords CSV file exported from a browser or a password manager."
      >
        <Rows>
          <ListRow
            label="Bookmarks HTML or passwords CSV"
            description="Choose the file in the import dialog"
            control
            trailing={
              <V2Button onClick={() => open(FILE_SOURCE.bookmarks)} data-testid="open-import-file">
                Import file…
              </V2Button>
            }
          />
        </Rows>
      </Group>
      {last && (
        <Group heading="Last import">
          <Rows>
            <ListRow
              label={resultHeadline(last)}
              description={`${resultCaption(last)} · ${summaryLine(last)}`}
              leading={<StatusGlyph state={last.error ? 'warning' : 'safe'} />}
              control
              trailing={
                <V2Button
                  onClick={() => run('import.dismiss', undefined)}
                  data-testid="import-dismiss-last"
                >
                  Dismiss
                </V2Button>
              }
              data-testid="import-last"
            />
          </Rows>
        </Group>
      )}
    </Pane>
  )
}
