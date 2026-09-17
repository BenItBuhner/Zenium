import type { ApiHost, NamespaceHandlers } from './types'

/**
 * The legacy `chrome.extension` namespace. `getURL`, `getViews`, `getBackgroundPage`,
 * `inIncognitoContext`, `sendRequest` / `onRequest` and `lastError` are provided by the shim
 * itself (they are aliases onto `runtime` and the context registry); the members here need the
 * browser's knowledge of how the extension was loaded.
 */
export class ExtensionApi {
  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    // The registry gains an incognito flag with the store restructuring; nothing grants it yet.
    isAllowedIncognitoAccess: () => false,
    // `ExtensionService` loads every extension with `allowFileAccess: true`.
    isAllowedFileSchemeAccess: (ctx) => this.host.loaded(ctx.extensionId) !== undefined,
    setUpdateUrlData: () => undefined
  }
}
