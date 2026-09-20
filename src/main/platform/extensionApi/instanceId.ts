import { randomBytes } from 'node:crypto'
import {
  INSTANCE_ID_DISABLED,
  INSTANCE_ID_INVALID_PARAMETER,
  formatInstanceId,
  isInstanceIdRecord,
  validateTokenParams,
  type InstanceIdRecord
} from '../../../core/extensions/api/instanceId'
import { ApiError, type ApiHost, type NamespaceHandlers } from './types'

/**
 * `chrome.instanceID` on the desktop, Chrome's `InstanceIDImpl` with GCM off: the ID and its
 * creation time live in the API store per extension (Chrome keeps them in the GCM store),
 * generated in Chrome's format by the first `getID` (or `getToken`, which generates the ID
 * before asking the server) and stable until `deleteID`. Tokens are the GCM channel's, which
 * Zenium has no client for, so `getToken` / `deleteToken` fail with Chrome's `DISABLED` result
 * (`chrome.gcm` fails with `GCM_DISABLED` beside it), `deleteToken` before any ID with
 * `INVALID_PARAMETER`, and `deleteID` drops the local ID and reports the failed revocation, as
 * Chrome's `OnDeleteIDCompleted` does. `getCreationTime` is 0 before an ID exists.
 * `onTokenRefresh` exists and never fires.
 */
export class InstanceIdApi {
  constructor(
    private readonly host: ApiHost,
    private readonly now: () => number = () => Date.now(),
    private readonly random: (bytes: number) => Uint8Array = (bytes) => randomBytes(bytes)
  ) {}

  readonly handlers: NamespaceHandlers = {
    getID: (ctx) => this.ensure(ctx.extensionId).id,
    getCreationTime: (ctx) => this.record(ctx.extensionId)?.creationTime ?? 0,
    getToken: (ctx, params) => this.getToken(ctx.extensionId, params),
    deleteToken: (ctx, params) => this.deleteToken(ctx.extensionId, params),
    deleteID: (ctx) => this.deleteId(ctx.extensionId)
  }

  private record(extensionId: string): InstanceIdRecord | undefined {
    const stored = this.host.store.instanceId(extensionId)
    return isInstanceIdRecord(stored) ? stored : undefined
  }

  private ensure(extensionId: string): InstanceIdRecord {
    const existing = this.record(extensionId)
    if (existing) return existing
    const record: InstanceIdRecord = {
      id: formatInstanceId(this.random(8)),
      creationTime: this.now()
    }
    this.host.store.setInstanceId(extensionId, record)
    return record
  }

  private getToken(extensionId: string, params: unknown): never {
    validate(params)
    this.ensure(extensionId)
    throw new ApiError(INSTANCE_ID_DISABLED)
  }

  private deleteToken(extensionId: string, params: unknown): never {
    validate(params)
    if (!this.record(extensionId)) throw new ApiError(INSTANCE_ID_INVALID_PARAMETER)
    throw new ApiError(INSTANCE_ID_DISABLED)
  }

  /** Nothing to delete is a success; otherwise the ID goes and the token revocation's result is reported. */
  private deleteId(extensionId: string): void {
    if (!this.record(extensionId)) return
    this.host.store.setInstanceId(extensionId, null)
    throw new ApiError(INSTANCE_ID_DISABLED)
  }
}

function validate(params: unknown): void {
  try {
    validateTokenParams(params)
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : String(error))
  }
}
