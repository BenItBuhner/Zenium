import type { Mod } from './types'

/**
 * The most CSS one Mod holds. `ModService.add` and `update` cut a longer sheet to it, and the
 * sync slice's apply side cuts a peer's record the same way (`sanitizeMod`): a sheet a peer's
 * build let grow past the cap lands cut, never whole.
 */
export const MAX_MOD_CSS = 512 * 1024

/** The name a Mod takes when the user gives none (`ModService.add`; the apply side's reading too). */
export const UNTITLED_MOD = 'Untitled mod'

/**
 * `raw` as one Mod in the list's normal form under `id` – `id`, `name`, `source`, `css`,
 * `enabled`, `updatedAt`, the order `ModService`'s writes leave behind – or null for a malformed
 * one (no CSS string). The name is trimmed and never empty (the service's own rule at add and
 * update; `UNTITLED_MOD` for none), `source` a string or null, the CSS cut to `MAX_MOD_CSS`,
 * `enabled` a boolean (on when the field is missing, as a Mod is added), `updatedAt` a finite
 * time (0 when none). Unknown fields are dropped. A well-formed Mod comes back byte for byte.
 * The sync slice's apply side puts a received record through this before it joins the list.
 */
export function sanitizeMod(id: string, raw: unknown): Mod | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.css !== 'string') return null
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  return {
    id,
    name: name || UNTITLED_MOD,
    source: typeof r.source === 'string' ? r.source : null,
    css: r.css.slice(0, MAX_MOD_CSS),
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    updatedAt:
      typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) && r.updatedAt >= 0
        ? r.updatedAt
        : 0
  }
}
