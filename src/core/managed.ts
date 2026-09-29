import { isManaged, managedStatusOf, unmanaged, type ManagedStatus } from '../shared/managed'
import type { Browser } from './browser'

/**
 * How long the app menu's first build waits for the host's read before it shows the menu
 * unmanaged (`browser.ts` `app.menu` → {@link ManagedService.ensureWithin}). The read is a
 * Binder call and a small file in `system_server` behind one bridge hop – milliseconds, tens on
 * a busy phone – so the bound is an order past the read's slow case and fires only when the host
 * is stuck, where the menu at once beats the row: past ~400 ms a tap's answer reads as a stall,
 * not a response, and the row is on the next opening anyway, the read kept when it lands.
 */
export const MANAGED_MENU_WAIT_MS = 400

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
  /** Whether a bounded wait has run out: the app menu waits for the read once, never after. */
  private timedOut = false

  constructor(private readonly browser: Browser) {}

  /**
   * The status once read, else `null` – what the app menu gates its row on without waiting. A
   * host with no bundle to read is unmanaged from the first ask, with no read to wait for.
   */
  status(): ManagedStatus | null {
    if (this.read === null && !this.browser.platform.managed) this.read = unmanaged()
    return this.read
  }

  /** Whether the answer is in (a host without a bundle counts as answered). */
  known(): boolean {
    return this.status() !== null
  }

  /**
   * Whether the app menu's build waits for the read ({@link ensureWithin}): the status unread
   * and no bounded wait run out yet. A host without a bundle, a build after the answer, and
   * every build after a wait has run out show at once; the row follows the answer, which is
   * kept when it lands.
   */
  waits(): boolean {
    return !this.known() && !this.timedOut
  }

  /** Whether the row and the page apply now: a read that found keys. */
  managed(): boolean {
    return isManaged(this.status())
  }

  /**
   * Read the bundle on the first call; every later call resolves the kept status. Always a
   * `ManagedStatus`, never a rejection: the host's reply – typed `ManagedStatus` by its bridge,
   * which declares the shape and does not check it – goes through `managedStatusOf`, and a read
   * that rejects is the unmanaged status, kept.
   */
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

  /**
   * {@link ensure}, bounded: the status when the read lands within `ms`, else `null` – still
   * unread – with the read running on and kept for the next ask. The app menu's first build
   * waits this way (`MANAGED_MENU_WAIT_MS`): a host that has not answered by then shows the menu
   * as an unmanaged host does, no later build waits ({@link waits}), and the row is on the next
   * opening once the answer is in. A status already known resolves at once, with no timer set.
   */
  ensureWithin(ms: number): Promise<ManagedStatus | null> {
    const known = this.status()
    if (known !== null) return Promise.resolve(known)
    let timer: ReturnType<typeof setTimeout> | null = null
    const bound = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        this.timedOut = true
        resolve(null)
      }, ms)
    })
    return Promise.race([this.ensure(), bound]).then((status) => {
      if (timer) clearTimeout(timer)
      return status
    })
  }
}
