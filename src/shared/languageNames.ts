/**
 * Readable names for the BCP 47 codes the translation registry speaks ("es" → "Spanish",
 * "zh-Hans" → "Simplified Chinese"), in the UI's own language when the runtime knows it. Shared
 * by the core (menu labels) and the chrome (bar, popover, settings).
 */

const cache = new Map<string, Intl.DisplayNames | null>()

function displayNames(locale: string): Intl.DisplayNames | null {
  let names = cache.get(locale)
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'language', languageDisplay: 'standard' })
    } catch {
      names = null
    }
    cache.set(locale, names)
  }
  return names
}

/** The name of `code` in `locale` (the runtime's default when omitted); the code itself as a last resort. */
export function languageName(code: string, locale = 'en'): string {
  if (!code) return ''
  try {
    const name = displayNames(locale)?.of(code)
    if (name && name.toLowerCase() !== code.toLowerCase()) return name
  } catch {
    /* an unknown or malformed tag: fall through to the code */
  }
  return code
}

/** `languageName` for a list, sorted by name so menus and lists read alphabetically. */
export function sortedByName(codes: readonly string[], locale = 'en'): string[] {
  return [...codes].sort((a, b) =>
    languageName(a, locale).localeCompare(languageName(b, locale), locale)
  )
}
