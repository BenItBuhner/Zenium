import {
  displayUnitInfos,
  SYSTEM_DISPLAY_CROS_ONLY_ERROR,
  SYSTEM_DISPLAY_CROS_ONLY_METHODS,
  SYSTEM_DISPLAY_NO_PERMISSION_ERROR,
  SYSTEM_DISPLAY_PERMISSION,
  type DisplayUnitInfo,
  type ScreenDisplay
} from '../../../core/extensions/api/systemDisplay'
import {
  ApiError,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

/** What the API needs of the engine's screen (`systemDisplayBridge.ts` wraps Electron's). */
export interface DisplayScreen {
  displays(): ScreenDisplay[]
  primary(): ScreenDisplay | null
  /** Hear of displays added, removed or changing their metrics; returns the unsubscribe. */
  observe(listener: () => void): () => void
}

/**
 * `chrome.system.display` over the browser's screens: `getInfo` as Chrome answers it off
 * ChromeOS, `getDisplayLayout` empty as there, the ChromeOS-only functions with Chrome's error,
 * `onDisplayChanged` to every extension holding the permission whenever the screens change.
 */
export class SystemDisplayApi {
  private unobserve: (() => void) | null = null

  constructor(
    private readonly host: ApiHost,
    private readonly screen: DisplayScreen
  ) {}

  readonly handlers: NamespaceHandlers = {
    getInfo: (ctx) => this.getInfo(ctx),
    getDisplayLayout: (ctx) => this.getDisplayLayout(ctx),
    ...Object.fromEntries(
      SYSTEM_DISPLAY_CROS_ONLY_METHODS.map((name) => [
        name,
        (ctx: ApiContext): never => this.chromeOsOnly(ctx)
      ])
    )
  }

  /** Watch the screens once an extension that can hear of them is loaded. */
  load(extension: LoadedExtension): void {
    if (this.unobserve || !this.permitted(extension.id)) return
    this.unobserve = this.screen.observe(() => this.displaysChanged())
  }

  /** The last permitted extension gone: stop watching. */
  unload(): void {
    if (!this.unobserve) return
    if (this.host.allLoaded().some((extension) => this.permitted(extension.id))) return
    this.unobserve()
    this.unobserve = null
  }

  private permitted(extensionId: string): boolean {
    return this.host.grants(extensionId).permissions.includes(SYSTEM_DISPLAY_PERMISSION)
  }

  private require(ctx: ApiContext): void {
    if (!this.permitted(ctx.extensionId)) throw new ApiError(SYSTEM_DISPLAY_NO_PERMISSION_ERROR)
  }

  private getInfo(ctx: ApiContext): DisplayUnitInfo[] {
    this.require(ctx)
    return displayUnitInfos(this.screen.displays(), this.screen.primary()?.id ?? null)
  }

  private getDisplayLayout(ctx: ApiContext): never[] {
    this.require(ctx)
    return []
  }

  private chromeOsOnly(ctx: ApiContext): never {
    this.require(ctx)
    throw new ApiError(SYSTEM_DISPLAY_CROS_ONLY_ERROR)
  }

  private displaysChanged(): void {
    this.host.broadcast('system.display', 'onDisplayChanged', (extension) =>
      this.permitted(extension.id) ? [] : null
    )
  }
}
