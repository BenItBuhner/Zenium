import type { JSX } from 'react'
import { run } from '@renderer/lib/api'
import {
  modelOptions,
  pairKey,
  useRegistryModels,
  type LanguageOption
} from '@renderer/lib/translate'
import { RowText } from '../pages/settings/rows'

/**
 * The lists a phone Settings › Languages "Add…" or "Download…" action row opens in its sheet
 * (§9.13: a menulist is not drawn on a phone settings page, its options come as a sheet): one
 * pressable §10.4 row per option, no current one to mark since every pick adds to a list, and a
 * pick closes the sheet. An option's description (a model's size) is the row's second line
 * (§9.2). The chassis focuses the first row as the sheet opens (§9.22).
 */
export function PickList({
  label,
  options,
  onPick,
  close
}: {
  label: string
  options: readonly LanguageOption[]
  onPick: (value: string) => void
  close: () => void
}): JSX.Element {
  return (
    <div role="group" aria-label={label} className="zen-settings-sheet-rows">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="zen-settings-row zen-settings-row-pressable zen-v2-row"
          onClick={() => {
            onPick(option.value)
            close()
          }}
        >
          <RowText label={option.label} description={option.description} />
        </button>
      ))}
    </div>
  )
}

/**
 * Settings › Languages › Download a model, on a phone: the pairs the registry offers that are
 * not on the device, each with its size; a pick starts the download (the models group shows it
 * arriving) and closes the sheet. While the list is on its way, and when every pair is already
 * on the device, one static row says so (§9.17, §9.34).
 */
export function ModelPickList({ close }: { close: () => void }): JSX.Element {
  const models = useRegistryModels('')
  const options = models ? modelOptions(models) : []
  if (models === null || options.length === 0) {
    return (
      <div className="zen-settings-sheet-rows">
        <div data-static="" className="zen-settings-row zen-v2-row">
          <RowText
            label={
              models === null ? 'Reading the list of models…' : 'Every model is on this device'
            }
          />
        </div>
      </div>
    )
  }
  return (
    <PickList
      label="Download a model"
      options={options}
      onPick={(key) => {
        const model = models.find((m) => pairKey(m) === key)
        // The list shows the pair arriving (`state.translate.downloading`) and the bar's error
        // state is the engine's; a failed fetch ahead of time just leaves the pair off the list.
        if (model) run('translate.downloadModel', { from: model.from, to: model.to })
      }}
      close={close}
    />
  )
}
