import { isPrereleaseVersion, type UpdateTarget } from '@shared/updates'

/*
 * The words of Settings › About's head (settings-73; `AboutVersionBlock`): the version with its
 * channel, and the copyright and licence line, kept apart from the block so the block's file
 * exports the component alone.
 */

/** The year of the first release, the copyright line's start. */
const FIRST_YEAR = 2026
/** `package.json`'s `author` and `license`, as the copyright line says them. */
const AUTHOR = 'Zenium contributors'
const LICENCE = 'Apache License 2.0'

/**
 * The build's channel, as About names it beside the version (Chrome's "Version 1xx (Official
 * Build) (64-bit)"). The build carries no channel marker of its own: a pre-release tag in the
 * version is the Beta channel (as `effectiveChannel` in `shared/updates.ts` reads it), anything
 * else is Stable, and a dev run – the `dev` target, `npm run dev` – says so. Once the release
 * worker stamps a channel into the build (a `channel` field in `package.json`, or a
 * `ZENIUM_CHANNEL` define in both Vite configs), read it here ahead of the version.
 */
export function buildChannel(version: string, target: Pick<UpdateTarget, 'kind'>): string {
  if (target.kind === 'dev') return 'Development build'
  return isPrereleaseVersion(version) ? 'Beta' : 'Stable'
}

/** "Version 0.4.31 · Stable": the row's one line under the wordmark. */
export function versionLine(version: string, target: Pick<UpdateTarget, 'kind'>): string {
  return `Version ${version} · ${buildChannel(version, target)}`
}

/** "© 2026 Zenium contributors · Apache License 2.0", the span growing with the year. */
export function copyrightLine(year: number = new Date().getFullYear()): string {
  const span = year > FIRST_YEAR ? `${FIRST_YEAR}–${year}` : String(FIRST_YEAR)
  return `© ${span} ${AUTHOR} · ${LICENCE}`
}
