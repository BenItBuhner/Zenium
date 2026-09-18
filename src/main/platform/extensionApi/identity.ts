import {
  ERROR_FLOW_IN_PROGRESS,
  ERROR_GET_AUTH_TOKEN,
  ERROR_INTERACTION_REQUIRED,
  ERROR_PAGE_LOAD_FAILED,
  ERROR_TIMEOUT,
  ERROR_USER_CANCELLED,
  IdentityError,
  emptyProfileUserInfo,
  isRedirectBack,
  normalizeWebAuthFlowDetails,
  redirectUrl,
  type ProfileUserInfo,
  type WebAuthFlowDetails
} from '../../../core/extensions/api/identity'
import type { ZenWindow } from '../../../core/window'
import { ApiError, type ApiContext, type LoadedExtension, type NamespaceHandlers } from './types'

/** What the auth window reports to the flow. */
export interface AuthWindowEvents {
  /** A navigation is about to start or has been redirected to `url` (top frame). */
  navigating(url: string): void
  /** The top frame finished loading a page (the provider's UI is up). */
  loaded(): void
  /** The top frame failed to load (network error, blocked, ...). */
  failed(): void
  /** The window was closed, by the user or by `close`. */
  closed(): void
}

/** The window the provider's pages show in. */
export interface AuthWindow {
  /** Bring the window up for the user (interactive flows, or a non-interactive one that needs them). */
  show(): void
  close(): void
}

export interface AuthWindowHost {
  open(
    ext: LoadedExtension,
    url: string,
    owner: ZenWindow | undefined,
    events: AuthWindowEvents
  ): AuthWindow
}

interface Flow {
  win: AuthWindow
  settle: (result: { url: string } | { error: string }) => void
}

/**
 * `chrome.identity`: `launchWebAuthFlow` runs the provider's pages in a window of their own (the
 * extension's primary session, so an existing login with the provider carries) and ends when
 * the top frame heads for `https://<id>.chromiumapp.org/`, handing that URL back to the
 * extension. Non-interactive flows keep the window hidden and fail with "interaction required"
 * as soon as a page finishes loading without redirecting (the provider is asking the user
 * something), or on the timeout. `getRedirectURL` is pure. `getProfileUserInfo` is empty (no
 * signed-in browser account) and `getAuthToken` is refused for the same reason.
 */
export class IdentityApi {
  private readonly flows = new Map<string, Flow>()

  constructor(private readonly windows: AuthWindowHost) {}

  readonly handlers: NamespaceHandlers = {
    getRedirectURL: (ctx, details) => this.getRedirectURL(ctx, details),
    launchWebAuthFlow: (ctx, details) => this.launchWebAuthFlow(ctx, details),
    getProfileUserInfo: () => this.getProfileUserInfo(),
    getAuthToken: () => this.getAuthToken(),
    removeCachedAuthToken: () => undefined,
    clearAllCachedAuthTokens: () => undefined,
    getAccounts: () => []
  }

  private getRedirectURL(ctx: ApiContext, details: unknown): string {
    return checked(() => redirectUrl(ctx.extensionId, details))
  }

  private getProfileUserInfo(): ProfileUserInfo {
    return emptyProfileUserInfo()
  }

  private getAuthToken(): never {
    throw new ApiError(ERROR_GET_AUTH_TOKEN)
  }

  private launchWebAuthFlow(ctx: ApiContext, raw: unknown): Promise<string> {
    const details = checked(() => normalizeWebAuthFlowDetails(raw))
    if (this.flows.has(ctx.extensionId)) throw new ApiError(ERROR_FLOW_IN_PROGRESS)
    return this.run(ctx.extension, details, ctx.window)
  }

  private run(
    ext: LoadedExtension,
    details: WebAuthFlowDetails,
    owner: ZenWindow | undefined
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const settle = (result: { url: string } | { error: string }): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        this.flows.delete(ext.id)
        win.close()
        if ('url' in result) resolve(result.url)
        else reject(new ApiError(result.error))
      }
      const win = this.windows.open(ext, details.url, owner, {
        navigating: (url) => {
          if (isRedirectBack(ext.id, url)) settle({ url })
        },
        loaded: () => {
          if (done) return
          // The provider is showing a page: an interactive flow shows it to the user; a silent
          // one has failed, unless the extension asked to wait for a redirect regardless.
          if (details.interactive) win.show()
          else if (details.abortOnLoadForNonInteractive)
            settle({ error: ERROR_INTERACTION_REQUIRED })
        },
        failed: () => settle({ error: ERROR_PAGE_LOAD_FAILED }),
        closed: () => settle({ error: ERROR_USER_CANCELLED })
      })
      this.flows.set(ext.id, { win, settle })
      if (!details.interactive) {
        timer = setTimeout(
          () => settle({ error: ERROR_TIMEOUT }),
          details.timeoutMsForNonInteractive
        )
      }
    })
  }

  /** The extension is unloading: an open flow fails the way a closed window does. */
  unload(extensionId: string): void {
    this.flows.get(extensionId)?.settle({ error: ERROR_USER_CANCELLED })
  }

  /** Whether a flow is running for the extension. */
  running(extensionId: string): boolean {
    return this.flows.has(extensionId)
  }
}

function checked<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof IdentityError) throw new ApiError(error.message)
    throw error
  }
}
