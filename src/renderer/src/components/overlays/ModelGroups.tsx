import type { JSX } from 'react'
import { groupShows, type RowGroup, type SettingsRow } from '../pages/settings/model'
import { EmptyRow, Group, Rows } from '../siteControls/pane'
import { ChoiceRow, ListRow, SwitchRow } from '../siteControls/primitives'

/**
 * The Settings builder's groups (`pages/settings/model.ts`) drawn on a mouse with the desktop
 * pane's v2 primitives (§9.13, §10.3, §10.5), for a group one builder serves to both platforms
 * (Accessibility › Read aloud, `sections.tsx`'s `readAloudGroups`): a value row is a `ChoiceRow`
 * – the row with its menulist trailing, the row's explanation as its description – a switch
 * row a `SwitchRow`, an info row a static `ListRow` with its description, and an empty group its
 * one §9.17 line. The phone draws the same groups as its rows and picker sheets (`rows.tsx`).
 * The kinds that open a sheet on the phone (item, detail, field, form) have no desktop form
 * here: a group that needs them has a pane of its own.
 */
export function ModelGroups({ groups }: { groups: readonly RowGroup[] }): JSX.Element {
  return (
    <>
      {groups.filter(groupShows).map((group) => (
        <Group
          key={group.id}
          heading={group.heading ?? ''}
          description={group.description}
          data-model-group={group.id}
        >
          <Rows>
            {group.rows.length === 0 ? (
              <EmptyRow>{group.empty}</EmptyRow>
            ) : (
              group.rows.map((row) => <ModelRow key={row.id} row={row} />)
            )}
          </Rows>
        </Group>
      ))}
    </>
  )
}

function ModelRow({ row }: { row: SettingsRow }): JSX.Element | null {
  switch (row.kind) {
    case 'value':
      return (
        <div data-row={row.id}>
          <ChoiceRow
            label={row.label}
            description={row.description ?? row.sheetDescription}
            value={row.value}
            options={row.options}
            onChange={row.onChange}
            disabled={row.disabled}
          />
        </div>
      )
    case 'switch':
      return (
        <SwitchRow
          label={row.label}
          description={row.description}
          checked={row.checked}
          onChange={row.onChange}
          disabled={row.disabled}
          data-row={row.id}
        />
      )
    case 'info':
      return (
        <ListRow
          label={row.label}
          description={row.description}
          leading={row.leading}
          trailing={row.trailing}
          disabled={row.disabled}
          data-row={row.id}
        />
      )
    case 'action':
      return (
        <ListRow
          label={row.label}
          description={row.description}
          leading={row.leading}
          danger={row.destructive}
          busy={row.busy}
          disabled={row.disabled}
          onClick={row.onPress}
          data-row={row.id}
        />
      )
    default:
      return null
  }
}
