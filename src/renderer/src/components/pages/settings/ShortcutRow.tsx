import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { KeyBinding, Platform, Shortcut } from '@shared/types'
import { findConflicts, formatBinding } from '@shared/shortcuts'
import { conflictPrompt, recordKey, replaceConflicts } from '@shared/shortcutRecorder'
import { run } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { V2Button } from '../../extensions/v2'
import { RowText } from './rows'

/**
 * The recorder listens for one shortcut's chord at a time. While it does, the chrome's key
 * presses are its own: the core runs no shortcut off them (`shortcuts.recording`), and the
 * capture-phase listener below keeps them from every field. A chord another shortcut holds is
 * not taken silently: the row asks first.
 */
type Recorder =
  | { phase: 'idle' }
  | { phase: 'recording' }
  | { phase: 'conflict'; binding: KeyBinding; conflicts: Shortcut[] }

const IDLE: Recorder = { phase: 'idle' }

/**
 * Keyboard Shortcuts › one shortcut (Zen's shortcut manager as a Settings row, §10.5): the
 * label with its extra bindings, an unsupported note or a conflict as the description, and the
 * chord trailing it as a 32 px secondary button (§9.21). Pressing the button records: it reads
 * "Press keys…" until a chord is pressed – Backspace unbinds, Escape cancels, and a chord
 * another shortcut holds turns the row into the question with Replace and Cancel (Enter and
 * Escape answer it too). Recording ends when the button loses focus, so nothing typed
 * elsewhere is taken for a chord. Each row is its own recorder: the keyboard is in one place,
 * so only one records at a time.
 */
export function ShortcutRow({
  shortcut,
  shortcuts,
  platform
}: {
  shortcut: Shortcut
  /** Every shortcut in force: what a chord may conflict with. */
  shortcuts: Shortcut[]
  platform: Platform
}): JSX.Element {
  const [rec, setRec] = useState<Recorder>(IDLE)
  const recording = rec.phase === 'recording'
  const asking = rec.phase === 'conflict'

  // The core must know when the chrome is recording: the chord pressed must not also run.
  useEffect(() => {
    if (!recording) return
    run('shortcuts.recording', { recording: true })
    return () => run('shortcuts.recording', { recording: false })
  }, [recording])

  useEffect(() => {
    if (!recording) return
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
        shortcuts,
        shortcut.id
      )
      switch (outcome.kind) {
        case 'ignore':
          return
        case 'cancel':
          setRec(IDLE)
          return
        case 'unbind':
          run('shortcuts.update', { id: shortcut.id, binding: null })
          setRec(IDLE)
          return
        case 'bind':
          run('shortcuts.update', { id: shortcut.id, binding: outcome.binding })
          setRec(IDLE)
          return
        case 'conflict':
          setRec({ phase: 'conflict', binding: outcome.binding, conflicts: outcome.conflicts })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, shortcuts, shortcut.id])

  const replace = (): void => {
    if (rec.phase !== 'conflict') return
    for (const update of replaceConflicts(shortcut.id, rec.binding, rec.conflicts))
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

  const conflicts = shortcut.binding ? findConflicts(shortcuts, shortcut.binding, shortcut.id) : []
  const chord = formatBinding(shortcut.binding, platform)
  const notes: string[] = []
  if (shortcut.unsupported) notes.push('Not available in this build')
  if (shortcut.extraBindings.length > 0)
    notes.push(`Also ${shortcut.extraBindings.map((b) => formatBinding(b, platform)).join(', ')}`)
  if (conflicts.length > 0 && !recording)
    notes.push(`Also used by ${conflicts.map((c) => c.label).join(', ')}`)
  const description = asking
    ? conflictPrompt(rec.conflicts)
    : notes.length > 0
      ? notes.join(' · ')
      : undefined
  return (
    <div
      data-row={`shortcut:${shortcut.id}`}
      data-shortcut-id={shortcut.id}
      data-static=""
      className={cn(
        'zen-settings-row zen-settings-control-row zen-v2-row zen-settings-shortcut-row',
        shortcut.unsupported && 'zen-settings-row-disabled'
      )}
      data-conflict={(!asking && conflicts.length > 0) || undefined}
      role={asking ? 'alert' : undefined}
    >
      <RowText label={shortcut.label} description={description} />
      <span className="zen-settings-trailing zen-settings-control">
        {asking ? (
          <>
            <V2Button variant="primary" onClick={replace} autoFocus>
              Replace
            </V2Button>
            <V2Button onClick={() => setRec(IDLE)}>Cancel</V2Button>
          </>
        ) : (
          <V2Button
            className={cn('zen-settings-chord', !shortcut.binding && 'zen-settings-chord-unbound')}
            aria-label={`${shortcut.label}: ${chord}`}
            aria-pressed={recording}
            onClick={() => setRec(recording ? IDLE : { phase: 'recording' })}
            // Recording lasts while the keyboard is here: a click anywhere else ends it.
            onBlur={() => recording && setRec(IDLE)}
          >
            {recording ? 'Press keys…' : chord}
          </V2Button>
        )}
      </span>
    </div>
  )
}
