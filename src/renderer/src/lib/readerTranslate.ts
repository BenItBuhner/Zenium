import { languageName } from '@shared/languageNames'
import type { ReaderTranslateState, TranslateUIState } from '@shared/translate'
import { errorCaption, pairLabel } from './translate'
import { formatBytes } from './utils'

/**
 * Reader View's Translate rows' model (CT-36; `ReaderPreferencesPanel.tsx`'s `TranslateRows`
 * draws them): when the translation is at work, which language the Translate into row shows,
 * the action row's second line while the core works, and the reason when it did not.
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
 * are then disabled). The article's own language is never proposed once it is known
 * (`source`: the translation's, told when the core looked, or the page's as the page translate
 * detected it) – the core's `defaultTarget` rule, so a Translate on an article in the first
 * preferred language goes to the next one rather than answering "already in".
 */
export function readerTranslateTarget(
  translation: ReaderTranslateState | null,
  chosen: string | null,
  translate: Pick<TranslateUIState, 'languages' | 'preferences'>,
  pageSource: string | null = null
): string | null {
  if (chosen && translate.languages.includes(chosen)) return chosen
  if (translation?.target) return translation.target
  const source = translation?.source ?? pageSource
  const reaches = (code: string): boolean => translate.languages.includes(code)
  const other = (code: string): boolean => reaches(code) && code !== source
  return (
    translate.preferences.preferred.find(other) ??
    (other('en') ? 'en' : null) ??
    translate.preferences.preferred.find(reaches) ??
    (reaches('en') ? 'en' : null) ??
    translate.languages[0] ??
    null
  )
}

/**
 * The Translate row's second line after a failure (§9.33: the reason on the line that reports
 * it): the core's reason as a sentence, its "already in <code>" naming the language as the row
 * does (`languageName`), "Translation failed." when the core gave none.
 */
export function readerTranslateError(error: string | null | undefined): string {
  const already = /^this article is already in ([a-z]{2,3}(?:-[a-z0-9]+)*)\.?$/i.exec(
    error?.trim() ?? ''
  )
  if (already) return `This article is already in ${languageName(already[1])}.`
  return errorCaption(error) ?? 'Translation failed.'
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
