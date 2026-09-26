import type { JSX } from 'react'
import { useRef } from 'react'
import type { SearchEngine } from '@shared/types'
import { engineHost, isActiveSearchEngine, isPickableSearchEngine } from '@shared/search'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { EngineGlyph, RadioOption } from '../pages/settings/blocks'
import { PhoneSheet } from '../phone/PhoneSheet'

/**
 * The picker the phone omnibox's engine glyph opens (OMN-38): a §9.13 picker on the frame's
 * dialog host – the 48 header titled by the control's name, one §9.21 radio row per engine the
 * bar can search with (the shipped ones, then the user's own with the host they search under;
 * an extension's engine only while it is the default, since it is not the user's to pick), the
 * engine THIS query goes to checked and holding the focus (§9.22's `checked`). A pick closes the
 * sheet and hands the engine to the query alone – the field's glyph and placeholder follow, the
 * default is untouched – the way Chrome for Android's site search takes an engine for one query
 * (its own status logo answers no tap at all: `StatusMediator` sets its click listener to null;
 * the picker is Zenium's, gated in design-gate-requests.md). Once the query's engine is not the
 * default, the chassis's footer offers `Set as default`: `settings.update({ searchEngineId })`,
 * the Settings row's own command, so the EEA choice record (`searchChoice.choose`'s) is not
 * written by it. Escape, the scrim and the back gesture leave everything as it was.
 */
export function EnginePickerSheet({
  engines,
  current,
  defaultEngine,
  onPick,
  onSetDefault,
  onClose
}: {
  /** Every engine the bar knows (`state.searchEngines`). */
  engines: readonly SearchEngine[]
  /** The engine this query goes to now: the checked row. */
  current: SearchEngine
  /** The default (`settings.searchEngineId`'s, or an extension's). */
  defaultEngine: SearchEngine
  /** A row was picked for this query. Runs once the sheet has gone. */
  onPick: (engine: SearchEngine) => void
  /** Set as default was pressed for `current`. Runs once the sheet has gone. */
  onSetDefault: () => void
  /** The sheet has left the screen. */
  onClose: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  // The rows: what the Settings picker offers (an active engine of the user's or a shipped one,
  // no extension's), plus whatever is the default or this query's engine, so the checked row and
  // the way back to the default are always there.
  const rows = engines.filter(
    (e) =>
      e.id === current.id ||
      e.id === defaultEngine.id ||
      (e.source !== 'extension' && isActiveSearchEngine(e))
  )
  const canSetDefault =
    current.id !== defaultEngine.id && isPickableSearchEngine(engines, current.id)
  return (
    <PhoneSheet
      name="urlbar-engine"
      title={{ pose: 'header', text: 'Search engine' }}
      focus="checked"
      body="list"
      openExpanded="overflow"
      className="zen-settings-sheet"
      onClose={onClose}
      sheetRef={sheet}
      footer={
        canSetDefault ? (
          <button
            type="button"
            className="zen-v2-button"
            data-testid="urlbar-engine-set-default"
            onClick={() => sheet.current?.dismiss(onSetDefault)}
          >
            Set as default
          </button>
        ) : undefined
      }
    >
      <div className="zen-settings-sheet-body">
        <div role="radiogroup" aria-label="Search engine" className="zen-settings-sheet-rows">
          {rows.map((e) => (
            <RadioOption
              key={e.id}
              label={e.name}
              // The user's own engines name the host they search under, as the Settings picker's
              // rows do; a shipped engine's name is enough.
              description={e.source ? (engineHost(e) ?? undefined) : undefined}
              leading={<EngineGlyph engine={e} />}
              checked={e.id === current.id}
              onSelect={() => sheet.current?.dismiss(() => onPick(e))}
            />
          ))}
        </div>
      </div>
    </PhoneSheet>
  )
}
