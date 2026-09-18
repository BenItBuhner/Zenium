import {
  ERROR_INCOGNITO_SCOPE,
  PrivacyError,
  normalizeGetDetails,
  parseSetting,
  settingDetails,
  settingNotControllable,
  type ChromeSettingDetails,
  type PrivacySources
} from '../../../core/extensions/api/privacy'
import { ApiError, isRecord, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

const ERROR_NO_PERMISSION = "The extension does not have the 'privacy' permission."

/**
 * `chrome.privacy`: every `privacy.<section>.<setting>` answers `get` with what Zenium has (the
 * search-suggestion and password-saving switches; Chromium defaults for the rest; off for the
 * Google services and the Privacy Sandbox), always `not_controllable`. `set` and `clear` are
 * refused with a message naming the setting: extensions do not change Zenium's settings.
 */
export class PrivacyApi {
  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    get: (ctx, setting, details) => this.get(ctx, setting, details),
    set: (ctx, setting, details) => this.set(ctx, setting, details),
    clear: (ctx, setting, details) => this.set(ctx, setting, details)
  }

  private requirePermission(ctx: ApiContext): void {
    if (!this.host.grants(ctx.extensionId).permissions.includes('privacy')) {
      throw new ApiError(ERROR_NO_PERMISSION)
    }
  }

  private sources(): PrivacySources {
    const settings = this.host.browser.state.settings
    return {
      searchSuggestions: settings.searchSuggestions,
      offerToSavePasswords: settings.passwords.offerToSave
    }
  }

  private get(ctx: ApiContext, rawSetting: unknown, rawDetails: unknown): ChromeSettingDetails {
    this.requirePermission(ctx)
    const { name } = checked(() => parseSetting(rawSetting))
    checked(() => normalizeGetDetails(rawDetails))
    return settingDetails(name, this.sources())
  }

  private set(ctx: ApiContext, rawSetting: unknown, rawDetails: unknown): never {
    this.requirePermission(ctx)
    const { section, name } = checked(() => parseSetting(rawSetting))
    if (isRecord(rawDetails) && rawDetails.scope === 'incognito_persistent') {
      throw new ApiError(ERROR_INCOGNITO_SCOPE)
    }
    throw new ApiError(settingNotControllable(`privacy.${section}.${name}`))
  }
}

function checked<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof PrivacyError) throw new ApiError(error.message)
    throw error
  }
}
