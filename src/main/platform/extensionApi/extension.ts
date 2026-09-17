import type { ApiContext, ApiHost, NamespaceHandlers } from './types'

/**
 * The host side of the legacy `chrome.extension` namespace. `getURL`, `getViews`,
 * `getBackgroundPage`, `inIncognitoContext`, `sendRequest` / `onRequest` and `lastError` are
 * pure context-side aliases in the shim; only the registry-backed flags come here.
 */
export class ExtensionApi {
  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    // Extensions never run in the private (in-memory) session: Electron cannot load them there.
    isAllowedIncognitoAccess: () => false,
    isAllowedFileSchemeAccess: (ctx) => this.allowsFileAccess(ctx),
    setUpdateUrlData: () => undefined
  }

  /**
   * Chrome's "Allow access to file URLs" toggle. The registry exposes it as
   * `ExtensionInfo.allowFileAccess`; hosts without the field load extensions with file access.
   */
  private allowsFileAccess(ctx: ApiContext): boolean {
    const info = this.host.browser.extensions
      .list()
      .find((entry) => entry.path === ctx.extension.path) as
      | { allowFileAccess?: boolean }
      | undefined
    return info?.allowFileAccess ?? true
  }
}
