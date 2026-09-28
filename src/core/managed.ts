import { isManaged, managedStatusOf, unmanaged, type ManagedStatus } from '../shared/managed'
import type { Browser } from './browser'

/**
 * Who manages the browser (TB-13; `shared/managed.ts`), the host-neutral half. Reads the host's
 * app-restrictions bundle once, lazily – the app menu's first build and the Management page's
 * mount ask; nothing at start does – and keeps the answer for the core's lifetime: Chrome's
 * `AppRestrictionsProvider` reads at its first policy load and refreshes on the system's
 * `ACTION_APPLICATION_RESTRICTIONS_CHANGED` broadcast, which Zenium does not listen for yet, so a
 * bundle pushed while the app runs shows at the next start. A host without a `ManagedHost` is
 * unmanaged at once and is never asked; a read that fails counts as unmanaged and is kept, so a
 * host that cannot answer is not asked again on every opening of the menu.
 */
export class ManagedService {
  private read: ManagedStatus | null = null
  private inflight: Promise<ManagedStatus> | null = null

  constructor(private readonly browser: Browser) {}

  /**
   * The status once read, else `null` – what the app menu gates its row on without waiting. A
   * host with no bundle to read is unmanaged from the first ask, with no read to wait for.
   */
  status(): ManagedStatus | null {
    if (this.read === null && !this.browser.platform.managed) this.read = unmanaged()
    return this.read
  }

  /** Whether the answer is in: the menu's first build awaits {@link ensure}, the rest do not. */
  known(): boolean {
    return this.status() !== null
  }

  /** Whether the row and the page apply now: a read that found keys. */
  managed(): boolean {
    return isManaged(this.status())
  }

  /** Read the bundle on the first call; every later call resolves the kept status. */
  ensure(): Promise<ManagedStatus> {
    const known = this.status()
    if (known !== null) return Promise.resolve(known)
    if (this.inflight) return this.inflight
    const host = this.browser.platform.managed
    if (!host) return Promise.resolve(unmanaged())
    this.inflight = Promise.resolve()
      .then(() => host.read())
      .then(
        (value) => managedStatusOf(value),
        () => unmanaged()
      )
      .then((status) => {
        this.read = status
        this.inflight = null
        return status
      })
    return this.inflight
  }
}
