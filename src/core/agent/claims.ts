import type { AgentMode } from '../../shared/types'
import type { StoreIO } from '../platform'
import { randomToken } from './util'

/**
 * Durable agent sessions ("claims"): what an agent started with `zen_session start` – its name,
 * colour, mode and the groups it owns – kept apart from the MCP transport session that happens
 * to carry it. A transport session comes and goes (a dropped connection, a restarted shim or
 * editor, a browser restart); the claim stays until the agent ends it (`zen_session end`) or the
 * user releases it, and its groups stay the agent's the whole time: never orphaned, never
 * adoptable, never another agent's to take over. A new transport session binds to the claim with
 * the claim's secret key (`zen_session resume`), or by itself when the browser can prove it is
 * the same client (`AgentService.resurrect`, the stdio relay's renewal).
 *
 * Kept in the profile's `zen/agent-claims.json`, local to this device: the folder marks that
 * sync (`Folder.agent`) carry no claim, and a claim never travels.
 */

export const CLAIMS_FILE = 'agent-claims.json'

export interface AgentClaim {
  id: string
  /** The secret an agent resumes with; shown to it once, at `start`. */
  key: string
  name: string
  color: string
  mode: AgentMode
  takeScreen: boolean
  groupIds: string[]
  homeGroupId: string | null
  createdAt: number
  /** The last time a call ran under the claim. */
  lastSeenAt: number
  /** The transport session that last carried the claim (resumed automatically by that id). */
  lastSessionId: string | null
}

interface ClaimsFile {
  version: 1
  claims: AgentClaim[]
}

export class ClaimStore {
  private readonly claims = new Map<string, AgentClaim>()
  private writing: Promise<void> = Promise.resolve()
  private written = ''

  constructor(private readonly io: StoreIO) {
    this.load()
    this.written = JSON.stringify({ version: 1, claims: this.all() } satisfies ClaimsFile, null, 2)
  }

  all(): AgentClaim[] {
    return [...this.claims.values()]
  }

  get(id: string | null | undefined): AgentClaim | undefined {
    return id ? this.claims.get(id) : undefined
  }

  byKey(key: string): AgentClaim | undefined {
    const wanted = key.trim()
    if (!wanted) return undefined
    for (const c of this.claims.values()) if (sameSecret(c.key, wanted)) return c
    return undefined
  }

  bySession(sessionId: string): AgentClaim | undefined {
    for (const c of this.claims.values()) if (c.lastSessionId === sessionId) return c
    return undefined
  }

  /** The claim whose groups include `folderId`. */
  byGroup(folderId: string): AgentClaim | undefined {
    for (const c of this.claims.values()) if (c.groupIds.includes(folderId)) return c
    return undefined
  }

  create(
    init: Pick<AgentClaim, 'name' | 'color' | 'mode' | 'takeScreen'>,
    now: number
  ): AgentClaim {
    const claim: AgentClaim = {
      id: `claim_${randomToken().slice(0, 16)}`,
      key: `zk_${randomToken()}`,
      ...init,
      groupIds: [],
      homeGroupId: null,
      createdAt: now,
      lastSeenAt: now,
      lastSessionId: null
    }
    this.claims.set(claim.id, claim)
    this.save()
    return claim
  }

  delete(id: string): void {
    if (this.claims.delete(id)) this.save()
  }

  /** Write the claims behind the writes before (the host's write is atomic, not ordered). */
  save(): void {
    const doc: ClaimsFile = { version: 1, claims: this.all() }
    const text = JSON.stringify(doc, null, 2)
    if (text === this.written) return
    this.written = text
    this.writing = this.writing
      .then(() => this.io.write(CLAIMS_FILE, text))
      .catch((error: unknown) => {
        console.warn(`[zen mcp] ${CLAIMS_FILE} not written:`, error)
      })
  }

  flush(): Promise<void> {
    return this.writing
  }

  private load(): void {
    let raw: string | null = null
    try {
      raw = this.io.readSync(CLAIMS_FILE)
    } catch {
      return
    }
    if (!raw) return
    try {
      const doc = JSON.parse(raw) as Partial<ClaimsFile>
      for (const c of Array.isArray(doc.claims) ? doc.claims : []) {
        const claim = sanitize(c)
        if (claim) this.claims.set(claim.id, claim)
      }
    } catch {
      console.warn(`[zen mcp] ${CLAIMS_FILE} is unreadable; starting without claims`)
    }
  }
}

function sanitize(c: unknown): AgentClaim | null {
  if (typeof c !== 'object' || c === null) return null
  const o = c as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.key !== 'string' || typeof o.name !== 'string')
    return null
  const num = (v: unknown, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d)
  return {
    id: o.id,
    key: o.key,
    name: o.name,
    color: typeof o.color === 'string' ? o.color : '#3d8bff',
    mode: o.mode === 'foreground' ? 'foreground' : 'background',
    takeScreen: o.takeScreen === true,
    groupIds: Array.isArray(o.groupIds)
      ? o.groupIds.filter((g): g is string => typeof g === 'string')
      : [],
    homeGroupId: typeof o.homeGroupId === 'string' ? o.homeGroupId : null,
    createdAt: num(o.createdAt, 0),
    lastSeenAt: num(o.lastSeenAt, 0),
    lastSessionId: typeof o.lastSessionId === 'string' ? o.lastSessionId : null
  }
}

/** Compare secrets without stopping at the first differing character. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
