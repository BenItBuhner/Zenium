import type { ReaderTranslateState, TranslateUIState } from '@shared/translate'
import { pairLabel } from './translate'
import { formatBytes } from './utils'

/**
 * Reader View's Translate rows' model (CT-36; `ReaderPreferencesPanel.tsx`'s `TranslateRows`
 * draws them): when the translation is at work, which language the Translate into row shows,
 * and the action row's second line while the core works.
 */

/** The translation is at work: the row is busy (§9.30) and a press does nothing. */
export function readerTranslateWorking(t: ReaderTranslateState | null): boolean {
  return (
    t !== null &&
    (t.status === 'detecting' || t.status === 'downloading' || t.status === 'translating')
  )
}

/**
 * The language the Translate into row shows: what the user picked in this panel (the row is
 * theirs the moment they pick, the translation following), else the translation's own once
 * there is one, else the first preferred language the models reach – English, the pivot every
 * model reaches, when none does – or null when the registry names no language at all (the rows
 * are then disabled).
 */
export function readerTranslateTarget(
  translation: ReaderTranslateState | null,
  chosen: string | null,
  translate: Pick<TranslateUIState, 'languages' | 'preferences'>
): string | null {
  if (chosen && translate.languages.includes(chosen)) return chosen
  if (translation?.target) return translation.target
  const preferred = translate.preferences.preferred.find((code) =>
    translate.languages.includes(code)
  )
  if (preferred) return preferred
  if (translate.languages.includes('en')) return 'en'
  return translate.languages[0] ?? null
}

/** The Translate row's second line while the translation is at work. */
export function readerTranslateProgress(t: ReaderTranslateState): string {
  switch (t.status) {
    case 'detecting':
      return 'Working out the article’s language…'
    case 'downloading': {
      const model = pairLabel(t.source, t.target)
      const bytes =
        t.download && t.download.total > 0
          ? ` (${formatBytes(t.download.received)} of ${formatBytes(t.download.total)})`
          : ''
      return `Getting the ${model} model${bytes}…`
    }
    default: {
      const pair = pairLabel(t.source, t.target)
      const count =
        t.progress && t.progress.total > 0 ? ` ${t.progress.done} of ${t.progress.total}` : ''
      return pair ? `Translating from ${pair}…${count}` : `Translating…${count}`
    }
  }
}
