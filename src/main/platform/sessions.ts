import type { SessionHost } from '../../core/platform'
import { app, session, type Session } from 'electron'
import { DEFAULT_CONTAINER_ID } from '../../shared/types'

/**
 * Each Zen container maps to a persistent Chromium session partition, which gives it its own
 * cookies, storage and cache – exactly what Firefox's Multi-Account Containers provide.
 */
export class SessionManager implements SessionHost {
  private readonly sessions = new Map<string, Session>()
  private readonly onCreate: Array<(ses: Session, containerId: string) => void> = []

  constructor(private readonly userAgent: string) {}

  /** Register a hook that runs for every session (existing and future). */
  configure(hook: (ses: Session, containerId: string) => void): void {
    this.onCreate.push(hook)
    for (const [id, ses] of this.sessions) hook(ses, id)
  }

  partitionFor(containerId: string): string {
    return containerId === DEFAULT_CONTAINER_ID
      ? 'persist:zen-default'
      : `persist:zen-container-${containerId}`
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

  async clearContainerData(containerId: string): Promise<void> {
    const ses = this.sessions.get(containerId)
    if (!ses) return
    await ses.clearStorageData()
    await ses.clearCache()
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
