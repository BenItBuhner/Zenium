import type { JSX } from 'react'
import type { UIState } from '@shared/types'
import { activeTab } from '@renderer/lib/selectors'
import { openClearBrowsingData } from '@renderer/lib/ui'
import { V2Button } from '../v2/controls'
import { Group, Pane, Rows } from '../siteControls/pane'
import { ListRow } from '../siteControls/primitives'

/**
 * Settings > Clear Browsing Data on a mouse (design-language-v2-draft §9.21, §9.26): the pane
 * names what goes and leads to the dialog with a hugging button trailing its row. The dialog
 * itself is `siteControls/ClearBrowsingDataDialog`, mounted by `TabDialogs` so it renders
 * through the frame dialog host over Settings. The phone's row is the Settings builder's
 * (`siteControls/settingsRows.tsx`, `clear-data-open`), whose sheet is the same form.
 */
export function ClearBrowsingDataSection({ state }: { state: UIState }): JSX.Element {
  const containers = state.containers.length
  const open = (): void => void openClearBrowsingData(activeTab(state)?.id ?? null)
  return (
    <Pane
      title="Clear Browsing Data"
      description="Remove what Zenium kept while you browsed: history, cookies and site data, the cache, and more. Bookmarks, settings and your Spaces stay."
      data-testid="clear-browsing-data-section"
    >
      <Group
        heading="Clear browsing data"
        description="Choose a time range and what to remove. Cookies and site data go from every container."
      >
        <Rows>
          <ListRow
            label="History, cookies, cache and more"
            description={
              containers > 1
                ? `Across ${containers} containers and the private session`
                : 'Including the private session'
            }
            control
            trailing={
              <V2Button onClick={open} data-testid="open-clear-browsing-data">
                Clear data…
              </V2Button>
            }
          />
        </Rows>
      </Group>
    </Pane>
  )
}
