import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { KeyBinding, Shortcut, ShortcutGroup, ShortcutPreset, UIState } from '@shared/types'
import {
  SHORTCUT_GROUP_LABELS,
  SHORTCUT_PRESETS,
  SHORTCUT_PRESET_DESCRIPTIONS,
  SHORTCUT_PRESET_LABELS,
  bindingsEqual,
  defaultShortcuts,
  findConflicts,
  formatBinding
} from '@shared/shortcuts'
import { conflictPrompt, recordKey, replaceConflicts } from '@shared/shortcutRecorder'
import { run } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Choice, Group, MENULIST_HEIGHT, Row } from './SettingsPrimitives'

const GROUP_ORDER: ShortcutGroup[] = [
  'zen-compact-mode',
  'zen-workspace',
  'zen-split-view',
  'zen-other',
  'windowAndTabManagement',
  'navigation',
  'searchAndFind',
  'pageOperations',
  'historyAndBookmarks',
  'mediaAndDisplay',
  'devTools'
]

/** Height of the "Reset to preset" button (`Button` default size). */
const BUTTON_HEIGHT = 32

/**
 * The recorder listens for one shortcut's chord at a time. While it does, the chrome's key
 * presses are its own: the core runs no shortcut off them (`shortcuts.recording`), and the
 * capture-phase listener below keeps them from every field. A chord another shortcut holds is
 * not taken silently: the row asks first.
 */
type Recorder =
  | { phase: 'idle' }
  | { phase: 'recording'; id: string }
  | { phase: 'conflict'; id: string; binding: KeyBinding; conflicts: Shortcut[] }

const IDLE: Recorder = { phase: 'idle' }

/** Zen's keyboard shortcut manager on the Chrome or Zen preset: every binding is editable. */
export function ShortcutsSection({ state }: { state: UIState }): JSX.Element | null {
  const [filter, setFilter] = useState('')
  const [rec, setRec] = useState<Recorder>(IDLE)
  const q = filter.trim().toLowerCase()
  const preset = state.settings.shortcutPreset
  const recording = rec.phase === 'recording'

  // How many rows the user changed: the preset's table against the one in force.
  const changed = useMemo(() => {
    const defaults = new Map(
      defaultShortcuts(state.platform, preset).map((s) => [s.id, s.binding] as const)
    )
    return state.shortcuts.filter((s) => {
      const base = defaults.get(s.id)
      return base !== undefined && !bindingsEqual(base, s.binding)
    }).length
  }, [state.shortcuts, state.platform, preset])

  // The core must know when the chrome is recording: the chord pressed must not also run.
  useEffect(() => {
    if (!recording) return
    run('shortcuts.recording', { recording: true })
    return () => run('shortcuts.recording', { recording: false })
  }, [recording])

  useEffect(() => {
    if (rec.phase !== 'recording') return
    const { id } = rec
    const onKey = (e: KeyboardEvent): void => {
      // Capture phase, before any field sees the key: nothing types while recording.
      e.preventDefault()
      e.stopPropagation()
      const outcome = recordKey(
        {
          key: e.key,
          code: e.code,
          control: e.ctrlKey,
          alt: e.altKey,
          shift: e.shiftKey,
          meta: e.metaKey
        },
        state.shortcuts,
        id
      )
      switch (outcome.kind) {
        case 'ignore':
          return
        case 'cancel':
          setRec(IDLE)
          return
        case 'unbind':
          run('shortcuts.update', { id, binding: null })
          setRec(IDLE)
          return
        case 'bind':
          run('shortcuts.update', { id, binding: outcome.binding })
          setRec(IDLE)
          return
        case 'conflict':
          setRec({ phase: 'conflict', id, binding: outcome.binding, conflicts: outcome.conflicts })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [rec, state.shortcuts])

  const replace = (): void => {
    if (rec.phase !== 'conflict') return
    for (const update of replaceConflicts(rec.id, rec.binding, rec.conflicts))
      run('shortcuts.update', update)
    setRec(IDLE)
  }

  // The question is answered with the keyboard too: Enter takes the chord, Escape leaves it.
  useEffect(() => {
    if (rec.phase !== 'conflict') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setRec(IDLE)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        replace()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // `replace` reads `rec`, which is in the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec])

  const presetOptions = SHORTCUT_PRESETS.map((p) => ({
    value: p,
    label: SHORTCUT_PRESET_LABELS[p]
  }))
  return (
    <div className="flex flex-col gap-4">
      <Group title="Preset">
        <Row
          label="Shortcut set"
          hint={SHORTCUT_PRESET_DESCRIPTIONS[preset]}
          control={MENULIST_HEIGHT}
        >
          <Choice<ShortcutPreset>
            value={preset}
            options={presetOptions}
            onChange={(next) => run('settings.update', { shortcutPreset: next })}
          />
        </Row>
        <Row
          label="Your changes"
          hint={
            changed === 0
              ? 'Every shortcut is the preset’s.'
              : `${changed} ${changed === 1 ? 'shortcut differs' : 'shortcuts differ'} from the preset.`
          }
          control={BUTTON_HEIGHT}
        >
          <Button
            variant="secondary"
            disabled={changed === 0}
            onClick={() => run('shortcuts.reset', undefined)}
          >
            Reset to preset
          </Button>
        </Row>
      </Group>
      <div className="flex items-center gap-2">
        <Input
          placeholder="Filter shortcuts"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
      </div>
      <p className="text-[12px] text-[var(--zen-muted)]">
        Click a shortcut, then press the new keys. Backspace clears it, Esc cancels.
      </p>
      {GROUP_ORDER.map((group) => {
        const items = state.shortcuts.filter(
          (s) =>
            s.group === group &&
            !s.hidden &&
            (!q ||
              s.label.toLowerCase().includes(q) ||
              formatBinding(s.binding, state.platform).toLowerCase().includes(q))
        )
        if (items.length === 0) return null
        return (
          <section key={group}>
            <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--zen-muted)]">
              {SHORTCUT_GROUP_LABELS[group]}
            </h3>
            <div className="overflow-hidden rounded-xl border border-[var(--zen-border)]">
              {items.map((s) => (
                <ShortcutRow
                  key={s.id}
                  shortcut={s}
                  state={state}
                  recorder={rec.phase !== 'idle' && rec.id === s.id ? rec : IDLE}
                  onRecord={() =>
                    setRec(recording && rec.id === s.id ? IDLE : { phase: 'recording', id: s.id })
                  }
                  onCancel={() => setRec(IDLE)}
                  onReplace={replace}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function ShortcutRow({
  shortcut,
  state,
  recorder,
  onRecord,
  onCancel,
  onReplace
}: {
  shortcut: Shortcut
  state: UIState
  /** The recorder as far as this row is concerned: idle unless it is this row's chord. */
  recorder: Recorder
  onRecord: () => void
  onCancel: () => void
  onReplace: () => void
}): JSX.Element {
  const recording = recorder.phase === 'recording'
  const asking = recorder.phase === 'conflict'
  const conflicts = shortcut.binding
    ? findConflicts(state.shortcuts, shortcut.binding, shortcut.id)
    : []
  return (
    <div
      className={cn(
        'flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--zen-border)] px-3 py-1 last:border-b-0',
        shortcut.unsupported && 'opacity-60'
      )}
      data-shortcut-id={shortcut.id}
    >
      <span className="min-w-0 flex-1 truncate text-[13px]">
        {shortcut.label}
        {shortcut.unsupported && (
          <span className="ml-2 text-[11px] text-[var(--zen-muted)]">
            not available in this build
          </span>
        )}
      </span>
      {asking ? (
        <span className="flex items-center gap-2 text-[12px]" role="alert">
          <span className="text-amber-500">{conflictPrompt(recorder.conflicts)}</span>
          <Button size="sm" onClick={onReplace} autoFocus>
            Replace
          </Button>
          <Button size="sm" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </span>
      ) : (
        <>
          {shortcut.extraBindings.length > 0 && !recording && (
            <span className="hidden text-[11px] text-[var(--zen-muted)] md:inline">
              {shortcut.extraBindings.map((b) => formatBinding(b, state.platform)).join(', ')}
            </span>
          )}
          {conflicts.length > 0 && !recording && (
            <span
              className="text-[11px] text-amber-500"
              title={`Also used by: ${conflicts.map((c) => c.label).join(', ')}`}
            >
              conflict
            </span>
          )}
          <button
            type="button"
            className={cn(
              'zen-kbd h-7 min-w-[110px] justify-center px-2.5 text-[12px] hover:bg-[var(--zen-element-bg-hover)]',
              recording && 'ring-2 ring-[var(--zen-accent)]',
              !shortcut.binding && 'text-[var(--zen-muted)]'
            )}
            aria-label={`${shortcut.label}: ${formatBinding(shortcut.binding, state.platform)}`}
            aria-pressed={recording}
            onClick={onRecord}
            // Recording lasts while the keyboard is here: a click into the filter (or anywhere
            // else) ends it, so nothing typed there is taken for a chord.
            onBlur={() => recording && onCancel()}
          >
            {recording ? 'Press keys…' : formatBinding(shortcut.binding, state.platform)}
          </button>
        </>
      )}
    </div>
  )
}
