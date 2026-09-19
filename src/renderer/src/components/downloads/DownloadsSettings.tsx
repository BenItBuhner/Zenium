import type { JSX } from 'react'
import { useState } from 'react'
import type { DownloadSettings, Settings, UIState } from '@shared/types'
import { resolveDownloadSettings } from '@shared/downloads'
import { cmd } from '@renderer/lib/api'
import { downloadFolderLabel, parseAutoOpenTypes } from '@renderer/lib/downloadText'
import { cn } from '@renderer/lib/utils'

/**
 * Settings > Downloads on Android (design language v2 §6, §9.2): where files go, whether to ask
 * each time, the completion notification, when the downloads sheet shows itself, and the file
 * types that open on their own, as one group of rows. On a phone the chip strip names the pane
 * and the group takes a 15/600 heading (§9.26, §10.3); a tablet's two-pane layout opens on the
 * 22/600 section title. Desktop has its own downloads settings surface.
 */
export function DownloadsSettingsSection({
  state,
  set
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
}): JSX.Element {
  const settings = state.settings
  const d = resolveDownloadSettings(settings)
  // `settings.update` replaces the whole block, so every change carries the resolved rest;
  // `askWhereToSave` stays where it lives, at `Settings.askWhereToSave`.
  const patch = (p: Partial<DownloadSettings>): void => {
    const block: Partial<DownloadSettings> = { ...d, ...p }
    delete block.askWhereToSave
    set({ downloads: block })
  }

  const chooseFolder = async (): Promise<void> => {
    const directory = await cmd('download.chooseDirectory', undefined).catch(() => null)
    if (directory) patch({ directory })
  }

  return (
    <div className="zen-v2-settings">
      <h3 className="zen-v2-settings-title">Downloads</h3>
      <div className="zen-v2-row zen-v2-row-control">
        <div className="zen-v2-row-text">
          <span className="zen-v2-row-label zen-v2-row-label-wrap">Save files to</span>
        </div>
        <span className="zen-v2-menulist-wrap">
          <select
            className="zen-v2-menulist"
            aria-label="Save files to"
            value={d.directory ? 'chosen' : 'default'}
            onChange={(e) => {
              if (e.target.value === 'choose') void chooseFolder()
              else if (e.target.value === 'default') patch({ directory: null })
            }}
          >
            <option value="default">Downloads</option>
            {d.directory && <option value="chosen">{downloadFolderLabel(d.directory)}</option>}
            <option value="choose">Choose a folder…</option>
          </select>
        </span>
      </div>
      <CheckRow
        label="Always ask where to save files"
        description="Pick a folder and a name for every download."
        checked={d.askWhereToSave}
        onChange={(askWhereToSave) => set({ askWhereToSave })}
      />
      <CheckRow
        label="Notify when a download finishes"
        checked={d.notifyOnComplete}
        onChange={(notifyOnComplete) => patch({ notifyOnComplete })}
      />
      <CheckRow
        label="Show downloads when one starts"
        description="The notification shows progress either way."
        checked={d.openPanelOnStart}
        onChange={(openPanelOnStart) => patch({ openPanelOnStart })}
      />
      <CheckRow
        label="Show downloads when one finishes"
        checked={d.openPanelOnComplete}
        onChange={(openPanelOnComplete) => patch({ openPanelOnComplete })}
      />
      <AutoOpenRow types={d.autoOpenTypes} onChange={(autoOpenTypes) => patch({ autoOpenTypes })} />
    </div>
  )
}

/** A checkbox row: the whole row is the label, the box aligns with the first text line (§9.2). */
function CheckRow({
  label,
  description,
  checked,
  onChange
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className={cn('zen-v2-row zen-v2-check-row', description && 'zen-v2-row-two-line')}>
      <input
        type="checkbox"
        className="zen-v2-checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="zen-v2-row-text">
        <span className="zen-v2-row-label zen-v2-row-label-wrap">{label}</span>
        {description && <span className="zen-v2-row-description">{description}</span>}
      </span>
    </label>
  )
}

/** Chrome's "Open certain file types automatically" as one field of extensions. */
function AutoOpenRow({
  types,
  onChange
}: {
  types: string[]
  onChange: (types: string[]) => void
}): JSX.Element {
  const stored = types.join(', ')
  // The draft belongs to the stored value it was typed over; a change from elsewhere shows through.
  const [draft, setDraft] = useState({ over: stored, text: stored })
  const text = draft.over === stored ? draft.text : stored
  const commit = (): void => {
    const next = parseAutoOpenTypes(text)
    setDraft({ over: stored, text: next.join(', ') })
    if (next.join(',') !== types.join(',')) onChange(next)
  }
  return (
    <div className="zen-v2-row zen-v2-row-two-line">
      <div className="zen-v2-row-text">
        <label className="zen-v2-row-label zen-v2-row-label-wrap" htmlFor="zen-downloads-auto-open">
          Open these file types automatically
        </label>
        <span className="zen-v2-row-description">
          Comma-separated, for example pdf, png. Dangerous files never open on their own.
        </span>
        <input
          id="zen-downloads-auto-open"
          className="zen-v2-field"
          type="text"
          inputMode="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="pdf, png"
          value={text}
          onChange={(e) => setDraft({ over: stored, text: e.target.value })}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
        />
      </div>
    </div>
  )
}
