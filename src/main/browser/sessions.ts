import { app, session, type Session } from 'electron'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '../../shared/types'

/**
 * Each Zen container maps to a persistent Chromium session partition, which gives it its own
 * cookies, storage and cache – exactly what Firefox's Multi-Account Containers provide.
 *
 * Private windows share one in-memory partition (no `persist:` prefix) that is wiped when the
 * last private window closes, like Firefox's private browsing session.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly onCreate: Array<(ses: Session, containerId: string) => void> = []

  constructor(private readonly userAgent: string) {}

  /** Register a hook that runs for every session (existing and future). */
  configure(hook: (ses: Session, containerId: string) => void): void {
    this.onCreate.push(hook)
    for (const [id, ses] of this.sessions) hook(ses, id)
  }

  partitionFor(containerId: string): string {
    if (containerId === PRIVATE_CONTAINER_ID) return 'zen-private'
    return containerId === DEFAULT_CONTAINER_ID
      ? 'persist:zen-default'
      : `persist:zen-container-${containerId}`
  }

  isPersistent(containerId: string): boolean {
    return containerId !== PRIVATE_CONTAINER_ID
  }

  get(containerId: string): Session {
    const existing = this.sessions.get(containerId)
    if (existing) return existing
    const ses = session.fromPartition(this.partitionFor(containerId))
    ses.setUserAgent(this.userAgent)
    this.sessions.set(containerId, ses)
    for (const hook of this.onCreate) hook(ses, containerId)
    return ses
  }

  all(): Session[] {
    return [...this.sessions.values()]
  }

  /** Sessions that can hold extensions (Electron refuses to load them into in-memory sessions). */
  persistent(): Array<[string, Session]> {
    return [...this.sessions.entries()].filter(([id]) => this.isPersistent(id))
  }

  async clearContainerData(containerId: string): Promise<void> {
    const ses = this.sessions.get(containerId)
    if (!ses) return
    await ses.clearStorageData()
    await ses.clearCache()
  }

  /** Forget everything the private session accumulated (last private window closed). */
  async clearPrivate(): Promise<void> {
    await this.clearContainerData(PRIVATE_CONTAINER_ID)
  }
}

/**
 * Present a plain Chrome user agent. Sites treat unknown "Electron/x" tokens as bots and
 * serve degraded experiences; Zen likewise ships a standard Firefox UA.
 */
export function buildUserAgent(): string {
  return app.userAgentFallback
    .replace(/\sElectron\/[\d.]+/, '')
    .replace(new RegExp(`\\s${escapeRegExp(app.getName())}\\/[\\d.]+`), '')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
