import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImportKind, ImportProgress, ImportSource } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import {
  defaultGroup,
  reportedKinds,
  sourceGroups,
  type SourceGroup
} from '@renderer/lib/importData'

export type ImportPhase = 'loading' | 'form' | 'busy' | 'result'

/** The "From" entry a source id belongs to: its browser, or the file source itself. */
function groupKeyOf(sourceId: string): string {
  return sourceId.startsWith('file:') ? sourceId : (sourceId.split(':')[0] ?? sourceId)
}

export interface ImportForm {
  phase: ImportPhase
  /** Every source the host found, `null` while the probe runs. */
  sources: ImportSource[] | null
  groups: SourceGroup[]
  group: SourceGroup | null
  /** The chosen profile of the group (its only one, most often). */
  source: ImportSource | null
  checked: ReadonlySet<ImportKind>
  /** The kinds the Import press asks for: checked, and available from the source. */
  selected: ImportKind[]
  /** The running or finished import, when this dialog started it (or found it running). */
  progress: ImportProgress | null
  pickGroup(key: string): void
  pickProfile(id: string): void
  toggle(kind: ImportKind, on: boolean): void
  submit(): void
  /** Back to the form after a result, the sources probed again. */
  again(): void
  /** Probe the sources again (the user came back after closing a browser). */
  refresh(): void
}

/**
 * The import dialog's model (Chrome's `ImportDataDialog`): the sources probed as the dialog
 * opens and again whenever the window regains focus while the form is up – so a browser closed
 * in the meantime shows closed, Chrome's "Continue" re-check without a button – the chosen
 * browser and profile, the kinds checked (every available kind at first, as Chrome starts
 * with all of them checked), and `import.run`'s progress from the shared state. The dialog
 * shows the result of a run it started; a finished import lingering from before is dismissed
 * as the dialog opens so the form comes up clean.
 */
export function useImportForm(
  progress: ImportProgress | null,
  /** The `ImportSource.id` to open on (the first-run offer's pick); the first browser otherwise. */
  preselect: string | null = null
): ImportForm {
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const [groupKey, setGroupKey] = useState<string | null>(() =>
    preselect ? groupKeyOf(preselect) : null
  )
  const [sourceId, setSourceId] = useState<string | null>(preselect)
  const [checked, setChecked] = useState<ReadonlySet<ImportKind>>(new Set())
  const [submitted, setSubmitted] = useState(false)
  const probe = useRef(0)

  const refresh = useCallback((): void => {
    const seq = ++probe.current
    void cmd('import.sources', undefined).then((found) => {
      if (seq !== probe.current) return
      setSources(found ?? [])
    })
  }, [])

  useEffect(() => {
    // A result left by an earlier run (a dialog closed while it worked, the phone's rows) is
    // not this dialog's: it goes so the form starts clean.
    if (progress && progress.status !== 'running') run('import.dismiss', undefined)
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the dialog opens
  }, [])

  const groups = useMemo(() => sourceGroups(sources ?? []), [sources])
  const group = useMemo(
    () => groups.find((g) => g.key === groupKey) ?? defaultGroup(groups),
    [groups, groupKey]
  )
  const source = useMemo(
    () => group?.profiles.find((p) => p.id === sourceId) ?? group?.profiles[0] ?? null,
    [group, sourceId]
  )

  // The kinds start all checked for whatever source is chosen (Chrome starts with every box
  // checked); a change of source keeps the user's unchecking and checks the rest.
  const unchecked = useRef(new Set<ImportKind>())
  useEffect(() => {
    if (!source) return
    setChecked(new Set(source.kinds.filter((k) => !unchecked.current.has(k))))
  }, [source])

  // The form re-checks the machine when the window comes back (Chrome's lock dialog's
  // "Continue", without the button): a browser closed meanwhile reads as closed.
  const showing = submitted ? null : 'form'
  useEffect(() => {
    if (showing !== 'form') return
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [showing, refresh])

  const selected = useMemo(
    () => (source ? source.kinds.filter((k) => checked.has(k)) : []),
    [source, checked]
  )

  const submit = useCallback((): void => {
    if (!source || selected.length === 0 || submitted) return
    setSubmitted(true)
    void cmd('import.run', { source: source.id, kinds: selected }).then((finished) => {
      // A file pick the user cancelled is no result: the form comes back as it was.
      if (!finished || (finished.status === 'cancelled' && reportedKinds(finished).length === 0)) {
        run('import.dismiss', undefined)
        setSubmitted(false)
      }
    })
  }, [source, selected, submitted])

  const again = useCallback((): void => {
    run('import.dismiss', undefined)
    setSubmitted(false)
    refresh()
  }, [refresh])

  // Busy from the press until the state carries the run (its first `running` progress may
  // arrive a tick after `import.run` is sent), then the result once the run has finished.
  const running = progress?.status === 'running'
  const phase: ImportPhase = running
    ? 'busy'
    : submitted
      ? progress
        ? 'result'
        : 'busy'
      : sources === null
        ? 'loading'
        : 'form'

  return {
    phase,
    sources,
    groups,
    group,
    source,
    checked,
    selected,
    progress,
    pickGroup: (key) => {
      setGroupKey(key)
      setSourceId(null)
    },
    pickProfile: setSourceId,
    toggle: (kind, on) => {
      if (on) unchecked.current.delete(kind)
      else unchecked.current.add(kind)
      setChecked((prev) => {
        const next = new Set(prev)
        if (on) next.add(kind)
        else next.delete(kind)
        return next
      })
    },
    submit,
    again,
    refresh
  }
}
