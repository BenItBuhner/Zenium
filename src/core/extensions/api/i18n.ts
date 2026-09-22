/**
 * `chrome.i18n` message resolution: Chrome's locale fallback chain, `$1`-style and named
 * placeholders, and the `__MSG_name__` substitution manifests use. Pure functions over the parsed
 * `_locales/<locale>/messages.json`, shared by the browser-side manifest reader and the
 * context-side engine (`engine.ts`), where `getMessage` answers synchronously without the host.
 */

/** `_locales/<locale>/messages.json`, already parsed. */
export type LocaleMessages = Record<
  string,
  { message: string; placeholders?: Record<string, { content: string }> }
>

const MSG_PLACEHOLDER = /__MSG_([A-Za-z0-9_@]+)__/g

/**
 * Chrome's locale fallback: the exact UI locale, its language, then `default_locale`. Locale
 * directory names use underscores (`en_US`).
 */
export function localeCandidates(uiLocale: string, defaultLocale: string | null): string[] {
  const normalised = uiLocale.replace('-', '_')
  const out: string[] = [normalised]
  const language = normalised.split('_')[0]
  if (language && language !== normalised) out.push(language)
  if (defaultLocale && !out.includes(defaultLocale)) out.push(defaultLocale)
  return out
}

/** Resolve one `chrome.i18n.getMessage` lookup (case-insensitive keys, `$1` and named placeholders). */
export function getMessage(
  messages: LocaleMessages | null,
  name: string,
  substitutions: string[] = []
): string {
  if (!messages) return ''
  const key = Object.keys(messages).find((k) => k.toLowerCase() === name.toLowerCase())
  if (!key) return ''
  const entry = messages[key]
  let text = entry.message
  if (entry.placeholders) {
    for (const [placeholder, { content }] of Object.entries(entry.placeholders)) {
      const value = content.replace(/\$(\d)/g, (_, n: string) => substitutions[Number(n) - 1] ?? '')
      text = text.replace(new RegExp(`\\$${placeholder}\\$`, 'gi'), value)
    }
  }
  text = text.replace(/\$(\d)/g, (_, n: string) => substitutions[Number(n) - 1] ?? '')
  return text.replace(/\$\$/g, '$')
}

/** Replace every `__MSG_name__` in `text` from the extension's messages (unknown names stay). */
export function substituteMessages(text: string, messages: LocaleMessages | null): string {
  if (!messages) return text
  return text.replace(MSG_PLACEHOLDER, (whole, name: string) => {
    const resolved = getMessage(messages, name)
    return resolved || whole
  })
}

/** The languages Chrome lays out right to left (`base::i18n::GetTextDirectionForLocale`). */
const RTL_LANGUAGES = new Set([
  'ar',
  'he',
  'iw',
  'fa',
  'ur',
  'ps',
  'yi',
  'ji',
  'sd',
  'ug',
  'dv',
  'ckb'
])

/**
 * Chrome's predefined messages (`@@ui_locale`, the four `@@bidi_*`, and `@@extension_id` when
 * an id is given: Chrome adds that one to a CSS file's substitution map alone, not to what
 * `i18n.getMessage` reads). The locale is spelled as a `_locales` directory is (`en_US`), the
 * direction is the UI language's.
 */
export function predefinedMessages(
  uiLocale: string,
  extensionId: string | null = null
): Record<string, string> {
  const locale = uiLocale.replace(/-/g, '_')
  const language = locale.split('_')[0]?.toLowerCase() ?? ''
  const rtl = RTL_LANGUAGES.has(language)
  const out: Record<string, string> = {
    '@@ui_locale': locale,
    '@@bidi_dir': rtl ? 'rtl' : 'ltr',
    '@@bidi_reversed_dir': rtl ? 'ltr' : 'rtl',
    '@@bidi_start_edge': rtl ? 'right' : 'left',
    '@@bidi_end_edge': rtl ? 'left' : 'right'
  }
  if (extensionId !== null) out['@@extension_id'] = extensionId
  return out
}

/**
 * A CSS content script's text as Chrome injects it: every `__MSG_name__` replaced, the
 * predefined messages first (`__MSG_@@extension_id__` is how a stylesheet names its own
 * resources, `url(chrome-extension://__MSG_@@extension_id__/icon.png)`; Steam Inventory Helper's
 * sheet reads it), then the extension's own messages; an unknown name stays. Chrome does this for
 * the manifest's `css` files and the files of `scripting.insertCSS` / `tabs.insertCSS`, never
 * for an inline `css` string.
 */
export function localizeCss(
  text: string,
  extensionId: string,
  uiLocale: string,
  messages: LocaleMessages | null
): string {
  if (!text.includes('__MSG_')) return text
  const predefined = predefinedMessages(uiLocale, extensionId)
  return text.replace(MSG_PLACEHOLDER, (whole, name: string) => {
    const reserved = predefined[name.toLowerCase()]
    if (reserved !== undefined) return reserved
    const resolved = getMessage(messages, name)
    return resolved || whole
  })
}

/** `chrome.i18n.getMessage`'s second argument: one string or up to nine, everything else ignored. */
export function normalizeSubstitutions(substitutions: unknown): string[] {
  if (substitutions === undefined || substitutions === null) return []
  if (Array.isArray(substitutions)) return substitutions.slice(0, 9).map(String)
  return [String(substitutions)]
}
