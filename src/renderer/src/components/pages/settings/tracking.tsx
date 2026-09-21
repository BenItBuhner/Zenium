import type { BlockingSettings, FilterListStatus, TrackingLevel } from '@shared/blocking'
import { customListId, siteOriginOf, TRACKING_LEVEL_LABELS } from '@shared/blocking'
import { run } from '@renderer/lib/api'
import {
  exceptionHost,
  listDetail,
  listOverrides,
  requests,
  statusCardText
} from '@renderer/lib/blockingUi'
import { relativeTime } from '@renderer/lib/utils'
import { choice, type RowGroup, type SettingsRow } from './model'
import type { SectionContext } from './sections'
import { AddListForm, AddSiteForm, FiltersForm } from './trackingForms'

/**
 * The request engine's rows of Settings › Privacy and Security on a phone (design language v2
 * §10.3–10.4): the groups the `privacy` builder in `sections.tsx` places at Chrome's "Tracking
 * prevention" position. Every row of the desktop pane (`overlays/PrivacySection.tsx`) is here in
 * its phone form – the master checkbox and the list checkboxes as switch rows, the level radios
 * as a value row with the §9.13 picker sheet, the lists and the excepted sites as item rows
 * with a sheet of rows each, the two add-fields and the filters editor as action rows with a
 * §9.12 form sheet, the status card's two lines as the group descriptions and an info row –
 * reading the same state and running the same commands. The master switch and the exceptions
 * are decisions of the `ads` permission, so they go through `blocking.setEnabled` /
 * `blocking.setSiteException` rather than the settings patch; the counter comes from core state.
 *
 * Self-contained: ids `tracking-*`, gated on `capabilities.requestBlocking` like the desktop
 * pane, so the Safe Browsing, cookies and site-settings programs add their groups to the same
 * builder around these.
 */
export function trackingGroups({ state, tab, set }: SectionContext): RowGroup[] {
  if (!state.capabilities.requestBlocking) return []
  const b = state.settings.blocking
  const status = state.blocking
  const setB = (patch: Partial<BlockingSettings>): void => set({ blocking: { ...b, ...patch } })
  const active = status.enabled && b.level !== 'off'
  const defaults = status.lists.filter((l) => l.tier !== null)
  const custom = status.lists.filter((l) => l.tier === null)
  const opener = tab.openerTabId ? state.tabs[tab.openerTabId] : undefined
  const origin = opener ? siteOriginOf(opener.url) : null

  const prevention: RowGroup = {
    id: 'tracking-prevention',
    heading: 'Tracking prevention',
    description:
      'Zenium blocks ads, trackers and malware hosts before a page can load them, with the open filter lists uBlock Origin uses.',
    rows: [
      {
        kind: 'switch',
        id: 'tracking-enabled',
        label: 'Block ads and trackers',
        description: 'Off lets every request through and keeps your lists and sites.',
        keywords: ['adblock', 'tracking', 'master switch'],
        checked: status.enabled,
        onChange: (enabled) => run('blocking.setEnabled', { enabled })
      },
      choice<TrackingLevel>({
        id: 'tracking-level',
        label: 'Level',
        keywords: ['tracking prevention level', 'strict', 'balanced', 'basic'],
        value: b.level,
        disabled: !status.enabled,
        sheetDescription:
          'Strict blocks the most, and some sites, videos or logins may stop working. When one does, add it to the sites without blocking.',
        options: (Object.keys(TRACKING_LEVEL_LABELS) as TrackingLevel[]).map((level) => ({
          value: level,
          label: TRACKING_LEVEL_LABELS[level].label,
          description: TRACKING_LEVEL_LABELS[level].description
        })),
        onChange: (level) => setB({ level })
      }),
      {
        kind: 'info',
        id: 'tracking-blocked',
        label: 'Blocked since Zenium started',
        description: status.ready ? requests(status.sessionBlocked) : 'Filter lists are loading',
        keywords: ['counter', 'blocked requests']
      }
    ]
  }

  const lists: RowGroup = {
    id: 'tracking-lists',
    heading: 'Filter lists',
    description: statusCardText(status, active, null, relativeTime).detail,
    rows: [
      {
        kind: 'switch',
        id: 'tracking-auto-update',
        label: 'Update lists automatically',
        description: 'About every four days, from their canonical URLs, as uBlock Origin does.',
        disabled: !status.enabled,
        checked: b.autoUpdate,
        onChange: (autoUpdate) => setB({ autoUpdate })
      },
      {
        kind: 'action',
        id: 'tracking-update-now',
        label: 'Update lists now',
        disabled: !active,
        busy: status.updating,
        button: 'Update now',
        onPress: () => run('blocking.updateLists', {})
      },
      ...defaults.map((l) =>
        listItem(l, [
          {
            kind: 'switch',
            id: `tracking-list:${l.id}:enabled`,
            label: 'Use this list',
            disabled: !active,
            checked: l.enabled,
            onChange: (on) => setB({ lists: listOverrides(b, l.id, on) })
          },
          updateListRow(l, active),
          homepageRow(l)
        ])
      )
    ]
  }

  const customLists: RowGroup = {
    id: 'tracking-custom-lists',
    heading: 'Your lists',
    rows: [
      ...custom.map((l) =>
        listItem(l, [
          {
            kind: 'switch',
            id: `tracking-list:${l.id}:enabled`,
            label: 'Use this list',
            disabled: !active,
            checked: l.enabled,
            onChange: (on) =>
              setB({
                customLists: b.customLists.map((c) => (c.id === l.id ? { ...c, enabled: on } : c))
              })
          },
          updateListRow(l, active),
          {
            kind: 'action',
            id: `tracking-list:${l.id}:remove`,
            label: 'Remove list',
            destructive: true,
            button: 'Remove…',
            confirm: {
              title: `Remove ${l.name}?`,
              description: 'Its filters stop applying. You can add the list again by its URL.',
              action: 'Remove'
            },
            onPress: () => setB({ customLists: b.customLists.filter((c) => c.id !== l.id) })
          }
        ])
      ),
      {
        kind: 'action',
        id: 'tracking-add-list',
        label: 'Add a list by its URL',
        keywords: ['custom list', 'subscribe'],
        disabled: !active,
        button: 'Add…',
        form: {
          title: 'Add a list',
          render: (close) => (
            <AddListForm
              taken={b.customLists.map((c) => c.url)}
              onAdd={(url) =>
                setB({
                  customLists: [
                    ...b.customLists,
                    { id: customListId(url), url, name: url, enabled: true }
                  ]
                })
              }
              close={close}
            />
          )
        }
      }
    ]
  }

  const filterLines = b.userFilters.split('\n').filter((line) => line.trim() !== '').length
  const errors = status.userFilterErrors
  const filters: RowGroup = {
    id: 'tracking-filters',
    heading: 'Your filters',
    description:
      'Filters of your own in uBlock Origin syntax. They apply at every level, even Off.',
    rows: [
      {
        kind: 'action',
        id: 'tracking-user-filters',
        label: 'Edit your filters',
        description:
          filterLines === 0
            ? 'None yet'
            : `${filterLines} ${filterLines === 1 ? 'filter' : 'filters'}${
                errors.length > 0
                  ? ` · ${errors.length} ${errors.length === 1 ? 'line' : 'lines'} not understood`
                  : ''
              }`,
        keywords: ['user filters', 'ublock', 'syntax'],
        button: 'Edit…',
        form: {
          title: 'Your filters',
          description: 'One filter per line.',
          render: (close) => (
            <FiltersForm
              value={b.userFilters}
              errors={errors}
              onSave={(userFilters) => setB({ userFilters })}
              close={close}
            />
          )
        }
      }
    ]
  }

  const exceptions: RowGroup = {
    id: 'tracking-exceptions',
    heading: 'Sites without blocking',
    description:
      'Nothing is blocked on these sites. Turning blocking off in the site information adds one.',
    rows: [
      ...(opener && origin
        ? [
            {
              kind: 'switch',
              id: 'tracking-site-current',
              label: `Block on ${exceptionHost(origin)}`,
              description: status.siteExceptions.includes(origin)
                ? 'The site you came from. Nothing is blocked there until this is on again.'
                : `The site you came from · ${requests(opener.blockedCount)} blocked on its page`,
              disabled: !active,
              checked: !status.siteExceptions.includes(origin),
              onChange: (on) => run('blocking.setSiteException', { site: origin, excepted: !on })
            } satisfies SettingsRow
          ]
        : []),
      ...status.siteExceptions.map((site): SettingsRow => ({
        kind: 'item',
        id: `tracking-site:${site}`,
        label: exceptionHost(site),
        description: 'Nothing is blocked on this site',
        keywords: ['exception', 'allowed site'],
        sheet: {
          title: exceptionHost(site),
          description: 'Nothing is blocked on this site.',
          groups: [
            {
              id: `tracking-site:${site}:actions`,
              heading: null,
              rows: [
                {
                  kind: 'action',
                  id: `tracking-site:${site}:block`,
                  label: 'Block on this site again',
                  button: 'Block again',
                  onPress: () => run('blocking.setSiteException', { site, excepted: false })
                }
              ]
            }
          ]
        }
      })),
      {
        kind: 'action',
        id: 'tracking-add-site',
        label: 'Add a site',
        keywords: ['exception', 'allow'],
        disabled: !active,
        button: 'Add…',
        form: {
          title: 'Add a site',
          description: 'Nothing is blocked on the site until you block on it again.',
          render: (close) => (
            <AddSiteForm
              onAdd={(site) => run('blocking.setSiteException', { site, excepted: true })}
              close={close}
            />
          )
        }
      }
    ]
  }

  return [prevention, lists, customLists, filters, exceptions]
}

/** A filter list as an item row: its name, size and freshness, and a sheet of rows about it. */
function listItem(l: FilterListStatus, rows: SettingsRow[]): SettingsRow {
  return {
    kind: 'item',
    id: `tracking-list:${l.id}`,
    label: l.name,
    description: listDetail(l, relativeTime, { blurb: false }),
    keywords: ['filter list', l.licence],
    sheet: {
      title: l.name,
      description: l.tier === null ? l.url : l.description,
      groups: [{ id: `tracking-list:${l.id}:actions`, heading: null, rows }]
    }
  }
}

function updateListRow(l: FilterListStatus, active: boolean): SettingsRow {
  return {
    kind: 'action',
    id: `tracking-list:${l.id}:update`,
    label: 'Update this list now',
    description: l.lastError ? `Update failed: ${l.lastError}` : undefined,
    disabled: !active || !l.enabled,
    busy: l.updating,
    button: 'Update now',
    onPress: () => run('blocking.updateLists', { id: l.id })
  }
}

function homepageRow(l: FilterListStatus): SettingsRow {
  return {
    kind: 'action',
    id: `tracking-list:${l.id}:homepage`,
    label: 'Open homepage',
    description: l.licence,
    leaves: 'external',
    onPress: () => run('app.openExternal', { url: l.homepage })
  }
}
