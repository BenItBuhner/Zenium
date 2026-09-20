import {
  answerSystemStorage,
  SYSTEM_STORAGE_METHODS,
  SYSTEM_STORAGE_NO_PERMISSION_ERROR,
  SYSTEM_STORAGE_PERMISSION
} from '../../../core/extensions/api/systemStorage'
import { ApiError, validated, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

/**
 * `chrome.system.storage` for the desktop: the engine's own namespace never exists (the permission
 * is withheld from the manifest it loads, since its implementation crashes the browser), so every
 * call comes here and gets Chrome's answer over no devices (`core/extensions/api/systemStorage.ts`).
 * Gated on the permission as declared: a required `system.storage` is granted at load, an optional
 * one never (`permissions.request` refuses it), so an extension without the grant gets Chrome's
 * no-permission error. `onAttached` and `onDetached` are never fired.
 */
export class SystemStorageApi {
  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = Object.fromEntries(
    SYSTEM_STORAGE_METHODS.map((name) => [
      name,
      (ctx: ApiContext, ...args: unknown[]): unknown => this.answer(ctx, name, args)
    ])
  )

  private permitted(extensionId: string): boolean {
    return this.host.grants(extensionId).permissions.includes(SYSTEM_STORAGE_PERMISSION)
  }

  private answer(ctx: ApiContext, method: string, args: unknown[]): unknown {
    if (!this.permitted(ctx.extensionId)) throw new ApiError(SYSTEM_STORAGE_NO_PERMISSION_ERROR)
    return validated(() => answerSystemStorage(method, args))
  }
}
