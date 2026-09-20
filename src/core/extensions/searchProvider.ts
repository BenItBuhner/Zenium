import type { SearchEngine, SearchEngineControl } from '../../shared/types'
import { engineGlyph } from '../../shared/search'

/**
 * `chrome_settings_overrides.search_provider`: the search engine an extension adds, and holds
 * the default with when `is_default` is set (Chrome's `SettingsOverridesAPI`). The engine lives
 * with the extension: it is derived from the manifest on load, dropped on unload, never written
 * to the settings and never synced, like Chrome's extension-controlled `TemplateURL`s.
 */

/** The manifest key, as Chrome's `manifest_types.json` declares it. */
export interface ManifestSearchProvider {
  name?: string
  keyword?: string
  favicon_url?: string
  search_url: string
  encoding?: string
  suggest_url?: string
  image_url?: string
  search_url_post_params?: string
  suggest_url_post_params?: string
  image_url_post_params?: string
  alternate_urls?: string[]
  prepopulated_id?: number
  is_default: boolean
}

export interface ManifestSettingsOverrides {
  homepage?: string
  search_provider?: ManifestSearchProvider
  startup_pages?: string[]
}

export interface ExtensionSearchProvider {
  extensionId: string
  extensionName: string
  engine: SearchEngine
  /** The manifest's `is_default`, honoured when the search URL takes the terms. */
  isDefault: boolean
}

/** An installed extension's provider with what decides between several: Chrome's install time. */
export interface InstalledSearchProvider {
  provider: ExtensionSearchProvider
  installedAt: number
}

/** Chrome's `{searchTerms}` placeholder against Zenium's `%s`. */
const SEARCH_TERMS = /\{searchTerms\}/g

/**
 * Chrome substitutes the Web Store's install parameter for `__PARAM__` in every URL of the
 * override (`SubstituteInstallParam`); a store install through Zenium carries none, so it is the
 * empty string, which is what Chrome writes for the overwhelming majority of installs too.
 */
const INSTALL_PARAM = /__PARAM__/g

/**
 * Chrome's prepopulated engines an override may name instead of spelling every field out
 * (`prepopulated_id`, `components/search_engines/prepopulated_engines.json`): the manifest's
 * own fields override these. An id this table does not know falls back to the manifest's
 * fields, as Chrome does (it logs the unknown id).
 */
const PREPOPULATED: Record<
  number,
  { name: string; keyword: string; searchUrl: string; suggestUrl: string | null; favicon: string }
> = {
  1: {
    name: 'Google',
    keyword: 'google.com',
    searchUrl: 'https://www.google.com/search?q=%s',
    suggestUrl: 'https://www.google.com/complete/search?client=chrome&q=%s',
    favicon: 'https://www.google.com/favicon.ico'
  },
  2: {
    name: 'Yahoo!',
    keyword: 'yahoo.com',
    searchUrl: 'https://search.yahoo.com/search?p=%s',
    suggestUrl: 'https://search.yahoo.com/sugg/chrome?output=fxjson&command=%s',
    favicon: 'https://search.yahoo.com/favicon.ico'
  },
  3: {
    name: 'Bing',
    keyword: 'bing.com',
    searchUrl: 'https://www.bing.com/search?q=%s',
    suggestUrl: 'https://www.bing.com/osjson.aspx?query=%s',
    favicon: 'https://www.bing.com/favicon.ico'
  },
  15: {
    name: 'Yandex',
    keyword: 'yandex.ru',
    searchUrl: 'https://yandex.ru/search/?text=%s',
    suggestUrl: 'https://suggest.yandex.ru/suggest-ff.cgi?part=%s',
    favicon: 'https://yandex.ru/favicon.ico'
  },
  90: {
    name: 'Baidu',
    keyword: 'baidu.com',
    searchUrl: 'https://www.baidu.com/s?wd=%s',
    suggestUrl: 'https://suggestion.baidu.com/su?wd=%s&action=opensearch',
    favicon: 'https://www.baidu.com/favicon.ico'
  },
  92: {
    name: 'DuckDuckGo',
    keyword: 'duckduckgo.com',
    searchUrl: 'https://duckduckgo.com/?q=%s',
    suggestUrl: 'https://duckduckgo.com/ac/?q=%s&type=list',
    favicon: 'https://duckduckgo.com/favicon.ico'
  },
  101: {
    name: 'Ecosia',
    keyword: 'ecosia.org',
    searchUrl: 'https://www.ecosia.org/search?q=%s',
    suggestUrl: 'https://ac.ecosia.org/autocomplete?q=%s&type=list',
    favicon: 'https://www.ecosia.org/favicon.ico'
  }
}

/** The engine id of an extension's provider: one per extension, never a shipped or user id. */
export function extensionEngineId(extensionId: string): string {
  return `extension:${extensionId}`
}

/** An `http(s)` URL Chrome would accept for the override (`CreateManifestURL`), or null. */
export function overrideUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value.replace(INSTALL_PARAM, ''))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** Chrome's template to Zenium's: install parameter substituted, `{searchTerms}` as `%s`. */
function template(value: string): string {
  return value.replace(INSTALL_PARAM, '').replace(SEARCH_TERMS, '%s')
}

/**
 * The engine an extension's manifest declares, or null when it declares none or one Chrome would
 * have dropped at install (the installer reports those; this stays lenient and consistent with
 * it: a `search_url` that is not an `http(s)` URL, or a spelled-out provider missing a field
 * Chrome requires without `prepopulated_id`).
 */
export function searchProviderOf(
  manifest: { chrome_settings_overrides?: unknown },
  extensionId: string,
  extensionName: string
): ExtensionSearchProvider | null {
  const overrides = manifest.chrome_settings_overrides
  if (typeof overrides !== 'object' || overrides === null) return null
  const provider = (overrides as ManifestSettingsOverrides).search_provider
  if (typeof provider !== 'object' || provider === null) return null
  const searchUrl = overrideUrl(provider.search_url)
  if (!searchUrl) return null
  const prepopulated =
    typeof provider.prepopulated_id === 'number'
      ? PREPOPULATED[provider.prepopulated_id]
      : undefined
  if (provider.prepopulated_id === undefined) {
    if (!provider.name || !provider.keyword || !provider.encoding || !provider.favicon_url) {
      return null
    }
    if (!overrideUrl(provider.favicon_url)) return null
  }
  const host = searchUrl.hostname.replace(/^www\./, '')
  const name = provider.name || prepopulated?.name || host
  const keyword = provider.keyword || prepopulated?.keyword || host
  const search = template(provider.search_url)
  const suggest =
    typeof provider.suggest_url === 'string' && overrideUrl(provider.suggest_url)
      ? template(provider.suggest_url)
      : (prepopulated?.suggestUrl ?? null)
  const favicon =
    typeof provider.favicon_url === 'string' && overrideUrl(provider.favicon_url)
      ? provider.favicon_url.replace(INSTALL_PARAM, '')
      : (prepopulated?.favicon ?? null)
  const engine: SearchEngine = {
    id: extensionEngineId(extensionId),
    name,
    searchUrl: search,
    suggestUrl: suggest,
    keyword,
    glyph: engineGlyph(name),
    source: 'extension',
    favicon
  }
  // Chrome makes no engine the default whose URL cannot take the terms (`SupportsReplacement`).
  const isDefault = provider.is_default === true && search.includes('%s')
  return { extensionId, extensionName, engine, isDefault }
}

/**
 * What the installed extensions' providers amount to: their engines in install order, and the
 * control of the default by the most recently installed one asking for it (Chrome: the newest
 * install wins, `SettingsOverridesAPI` keyed by `ExtensionPrefs::GetInstallTime`).
 */
export function resolveExtensionSearch(installed: readonly InstalledSearchProvider[]): {
  engines: SearchEngine[]
  control: SearchEngineControl | null
} {
  const ordered = [...installed].sort((a, b) => a.installedAt - b.installedAt)
  const engines = ordered.map((entry) => entry.provider.engine)
  const holder = [...ordered].reverse().find((entry) => entry.provider.isDefault)
  const control: SearchEngineControl | null = holder
    ? {
        engineId: holder.provider.engine.id,
        extensionId: holder.provider.extensionId,
        extensionName: holder.provider.extensionName
      }
    : null
  return { engines, control }
}
