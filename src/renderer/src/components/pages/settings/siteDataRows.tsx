import type { SiteDataList, SiteDataStatus } from '@shared/siteData'
import { run } from '@renderer/lib/api'
import {
  SITE_DATA_LIST_ORDER,
  SITE_DATA_TEXT,
  clearOnExitDescription,
  clearOnExitRows,
  siteDataDefaultOptions,
  siteDataListDescription,
  siteDataListHeading,
  siteDataPatternDescription,
  siteDataPrivateOnly,
  siteDataPrivateOnlyDescription,
  siteDataPrivateOnlyMode,
  toggleClearOnExitType
} from '@renderer/lib/siteDataUi'
import { AddPatternForm } from './AddPatternForm'
import { choice, type ActionRow, type RowGroup, type SettingsRow } from './model'
import { relatedSitesGroups } from './protectionRows'
import type { SectionContext } from './sections'
import { SiteDataViewer } from './SiteDataViewer'

/** The section's drill-in page the viewer row opens on the phone (`InternalPageSection.pages`). */
export const SITE_DATA_PAGE = 'site-data'

/**
 * Cookies and site data (Chrome's `chrome://settings/cookies`; PS-23, PS-24, PS-25) as rows of the
 * phone's Privacy and Security category (design language v2 §9.12–§9.14, §9.17, §10.2–§10.4),
 * the `privacySection` builder (`sections.tsx`) placing them at Chrome's cookies position: the
 * default as a value row whose §9.13 picker holds Chrome's three radios – "Block all cookies"
 * saying it is browser-wide (the container's cookie jar), not per site – with the third-party
 * setting's own row under it, the switch that keeps the block to the private contexts (the #322
 * ruling on Q3 folded the Third-party cookies group into this one: the default radio carries the
 * third-party state, `siteData.setDefault` writing `privacy.thirdPartyCookies`), then the
 * related sites that keep third-party cookies whatever the block says (`protectionRows.tsx`);
 * the three lists, each a group of item rows (a pattern in a 44 row, the clear-on-exit list's
 * with its timing under it, Remove in its sheet) with its §9.17 empty line and an Add row whose
 * sheet is the §9.12 form for the pattern; "Delete browsing data on exit" as one switch row per
 * type (the desktop's check rows); and "See all site data and permissions", which on the phone
 * leaves for the section's drill-in page (`zen://settings/privacy/site-data`, `SiteDataPage`:
 * Chrome's All sites, the #322 ruling (a)) and on the two-pane layout opens the viewer dialog
 * (`SiteDataViewer`, §10.5). Every row reads `state.siteData` (the engine's `SiteDataStatus`)
 * and runs the `siteData.*` commands or patches `settings.privacy`, so the two platforms say
 * and do the same thing.
 *
 * Row ids are prefixed `site-data` so they stay unique beside the other programs' groups.
 */
export function siteDataGroups(ctx: SectionContext): RowGroup[] {
  const { state, set } = ctx
  const status = state.siteData
  const windows = state.capabilities.windows
  const privacy = state.settings.privacy
  // The middle radio is on: the private-only switch and the related sites have a block to
  // qualify; under "Allow all" or "Block all" they are dependent rows at .4 (§10.4).
  const thirdParty = status.default === 'block-third-party'
  const privateOnly = siteDataPrivateOnly(privacy.thirdPartyCookies)
  const groups: RowGroup[] = [
    {
      id: 'site-data',
      heading: SITE_DATA_TEXT.heading,
      description: SITE_DATA_TEXT.description,
      rows: [
        choice({
          id: 'site-data-default',
          label: SITE_DATA_TEXT.default.label,
          keywords: [
            'cookies',
            'block all cookies',
            'allow all cookies',
            'third-party cookies',
            'site data'
          ],
          value: status.default,
          options: siteDataDefaultOptions(),
          sheetDescription: SITE_DATA_TEXT.default.sheetDescription,
          onChange: (value) => run('siteData.setDefault', { default: value })
        }),
        {
          kind: 'switch',
          id: 'site-data-private-only',
          label: SITE_DATA_TEXT.privateOnly.label(windows),
          description: siteDataPrivateOnlyDescription(privateOnly, windows),
          keywords: ['third-party cookies', 'private', 'tracking', 'block'],
          disabled: !thirdParty,
          checked: privateOnly,
          onChange: (on) =>
            set({ privacy: { ...privacy, thirdPartyCookies: siteDataPrivateOnlyMode(on) } })
        }
      ]
    },
    ...relatedSitesGroups(state, set, thirdParty)
  ]
  for (const list of SITE_DATA_LIST_ORDER) groups.push(...listGroups(list, status, windows))
  groups.push(
    {
      id: 'site-data-exit',
      heading: SITE_DATA_TEXT.clearOnExit.heading,
      description: clearOnExitDescription(status),
      rows: clearOnExitRows().map(({ type, label }): SettingsRow => ({
        kind: 'switch',
        id: `site-data-exit:${type}`,
        label,
        keywords: ['clear on exit', 'delete on exit', 'close', 'quit'],
        checked: status.clearOnExitTypes.includes(type),
        onChange: (on) =>
          set({
            privacy: {
              ...privacy,
              clearOnExit: { types: toggleClearOnExitType(status.clearOnExitTypes, type, on) }
            }
          })
      }))
    },
    {
      id: 'site-data-viewer',
      heading: null,
      rows: [
        {
          kind: 'action',
          id: 'site-data-see-all',
          label: SITE_DATA_TEXT.viewer.open,
          description: SITE_DATA_TEXT.viewer.openDescription,
          keywords: ['site data', 'storage', 'cookies', 'clear', 'origins', 'all sites'],
          button: 'See all…',
          // The phone leaves for the page (§10.2); the two-pane layout opens the dialog, whose
          // body is the list – the 80% cap and the list footer (§9.20).
          page: SITE_DATA_PAGE,
          form: {
            title: SITE_DATA_TEXT.viewer.title,
            description: SITE_DATA_TEXT.viewer.description,
            body: 'list',
            render: () => <SiteDataViewer />
          }
        }
      ]
    }
  )
  return groups
}

/** One list: its patterns as item rows under Chrome's heading, then the Add row of its own. */
function listGroups(list: SiteDataList, status: SiteDataStatus, windows: boolean): RowGroup[] {
  const heading = siteDataListHeading(list, windows)
  const nextLaunch = status.clearsAtNextLaunch
  const text = SITE_DATA_TEXT.lists
  return [
    {
      id: `site-data-${list}`,
      heading,
      description: siteDataListDescription(list, nextLaunch),
      rows: status[list].map((pattern): SettingsRow =>
        patternRow(list, pattern, heading, nextLaunch)
      ),
      empty: text.empty
    },
    {
      id: `site-data-${list}-add`,
      heading: null,
      rows: [
        {
          kind: 'action',
          id: `site-data-${list}-add`,
          label: text.add,
          description: text.addDescription,
          keywords: ['exception', 'pattern', heading],
          button: text.addButton,
          form: {
            title: text.add,
            description: heading,
            render: (close) => (
              <AddPatternForm list={list} status={status} windows={windows} close={close} />
            )
          }
        }
      ]
    }
  ]
}

/**
 * A pattern on a list: the pattern alone in a 44 row (the clear-on-exit list's with its timing
 * under it), and Remove in its sheet – in the text ink, since a list entry is a setting and not
 * the user's data (#297).
 */
function patternRow(
  list: SiteDataList,
  pattern: string,
  heading: string,
  nextLaunch: boolean
): SettingsRow {
  const remove: ActionRow = {
    kind: 'action',
    id: `site-data-site:${pattern}:remove`,
    label: SITE_DATA_TEXT.lists.remove,
    description: SITE_DATA_TEXT.lists.removeDescription,
    button: SITE_DATA_TEXT.lists.removeButton,
    onPress: () => run('siteData.remove', { pattern })
  }
  return {
    kind: 'item',
    id: `site-data-site:${pattern}`,
    label: pattern,
    description: siteDataPatternDescription(list, nextLaunch),
    keywords: [heading],
    sheet: {
      title: pattern,
      description: heading,
      groups: [{ id: `site-data-site:${pattern}:actions`, heading: null, rows: [remove] }]
    }
  }
}
