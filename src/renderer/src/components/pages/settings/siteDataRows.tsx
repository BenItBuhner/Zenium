import type { JSX } from 'react'
import { useId, useState } from 'react'
import type { SiteDataList, SiteDataStatus } from '@shared/siteData'
import { cmd, run } from '@renderer/lib/api'
import {
  SITE_DATA_LIST_ORDER,
  SITE_DATA_TEXT,
  clearOnExitDescription,
  clearOnExitRows,
  siteDataAddFeedback,
  siteDataDefaultOptions,
  siteDataListDescription,
  siteDataListHeading,
  siteDataPatternDescription,
  toggleClearOnExitType
} from '@renderer/lib/siteDataUi'
import { Field, SheetActions, ValidationMessage } from './blocks'
import { choice, type ActionRow, type RowGroup, type SettingsRow } from './model'
import type { SectionContext } from './sections'
import { SiteDataViewer } from './SiteDataViewer'

/**
 * Cookies and site data (Chrome's `chrome://settings/cookies`; PS-23, PS-24, PS-25) as rows of the
 * phone's Privacy and Security category (design language v2 §9.12–§9.14, §9.17, §10.3–§10.4),
 * the `privacySection` builder (`sections.tsx`) placing them after the third-party cookie
 * groups: the default as a value row whose §9.13 picker holds Chrome's three radios – "Block
 * all cookies" saying it is browser-wide (the container's cookie jar), not per site – then the
 * three lists, each a group of item rows (a pattern, what its list does for it, Remove in its
 * sheet) with its §9.17 empty line and an Add row whose sheet is the §9.12 form for the pattern;
 * "Delete browsing data on exit" as one switch row per type (the desktop's check rows); and
 * "See all site data and permissions", whose sheet is the viewer (`SiteDataViewer`). Every row
 * reads `state.siteData` (the engine's `SiteDataStatus`) and runs the `siteData.*` commands or
 * patches `settings.privacy.clearOnExit`, so the two platforms say and do the same thing.
 *
 * Row ids are prefixed `site-data` so they stay unique beside the other programs' groups.
 */
export function siteDataGroups({ state, set }: SectionContext): RowGroup[] {
  const status = state.siteData
  const windows = state.capabilities.windows
  const groups: RowGroup[] = [
    {
      id: 'site-data',
      heading: SITE_DATA_TEXT.heading,
      description: SITE_DATA_TEXT.description,
      rows: [
        choice({
          id: 'site-data-default',
          label: SITE_DATA_TEXT.default.label,
          keywords: ['cookies', 'block all cookies', 'allow all cookies', 'site data'],
          value: status.default,
          options: siteDataDefaultOptions(),
          sheetDescription: SITE_DATA_TEXT.default.sheetDescription,
          onChange: (value) => run('siteData.setDefault', { default: value })
        })
      ]
    }
  ]
  for (const list of SITE_DATA_LIST_ORDER) groups.push(...listGroups(list, status, windows))
  groups.push(
    {
      id: 'site-data-exit',
      heading: SITE_DATA_TEXT.clearOnExit.heading,
      description: clearOnExitDescription(status),
      rows: clearOnExitRows().map(
        ({ type, label }): SettingsRow => ({
          kind: 'switch',
          id: `site-data-exit:${type}`,
          label,
          keywords: ['clear on exit', 'delete on exit', 'close', 'quit'],
          checked: status.clearOnExitTypes.includes(type),
          onChange: (on) =>
            set({
              privacy: {
                ...state.settings.privacy,
                clearOnExit: { types: toggleClearOnExitType(status.clearOnExitTypes, type, on) }
              }
            })
        })
      )
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
          keywords: ['site data', 'storage', 'cookies', 'clear', 'origins'],
          button: 'See all…',
          form: {
            title: SITE_DATA_TEXT.viewer.title,
            description: SITE_DATA_TEXT.viewer.description,
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
      rows: status[list].map((pattern): SettingsRow => patternRow(list, pattern, heading, nextLaunch)),
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

/** A pattern on a list: the pattern, what the list does for it, and Remove in its sheet. */
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
    description: 'The site follows the default again.',
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

/**
 * Add a site (§9.12 in a sheet, Chrome's "Add a site" dialog): one field read in Chrome's
 * pattern grammar, its hint under it until what is typed is refused – then the validation text
 * stands there and Add waits at .4 (§9.30); a pattern on another list says it will move. Add
 * asks the engine (`siteData.add`), the §9.30 busy form while it answers: a refusal (not a
 * pattern, the list full) clears the field, gives it the focus and shows the reason.
 */
export function AddPatternForm({
  list,
  status,
  windows,
  close
}: {
  list: SiteDataList
  status: SiteDataStatus
  windows: boolean
  close: () => void
}): JSX.Element {
  const id = useId()
  const [value, setValue] = useState('')
  const [refused, setRefused] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const feedback = siteDataAddFeedback(status, list, value, windows)
  const problem = refused ?? feedback.problem
  const ready = value.trim() !== '' && problem === null
  const add = (): void => {
    if (!ready || busy) return
    setBusy(true)
    cmd('siteData.add', { list, pattern: value.trim() }).then(
      (result) => {
        setBusy(false)
        if (result.ok) {
          close()
          return
        }
        setRefused(result.problem)
        setValue('')
        document.getElementById(id)?.focus()
      },
      () => {
        setBusy(false)
        setRefused(SITE_DATA_TEXT.viewer.failed)
      }
    )
  }
  return (
    <div className="zen-settings-form" aria-busy={busy || undefined} data-testid="add-pattern-form">
      <Field
        id={id}
        label={SITE_DATA_TEXT.lists.field}
        description={problem ? undefined : feedback.hint}
      >
        <input
          id={id}
          className="zen-settings-input zen-v2-field"
          placeholder={SITE_DATA_TEXT.lists.placeholder}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          readOnly={busy}
          aria-invalid={problem ? true : undefined}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setRefused(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        {problem && <ValidationMessage message={problem} />}
      </Field>
      <SheetActions
        action={SITE_DATA_TEXT.lists.add}
        disabled={!ready}
        busy={busy}
        onCancel={close}
        onAction={add}
      />
    </div>
  )
}
