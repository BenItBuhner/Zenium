// The Android versionCode is derived from the package version (android/app/build.gradle.kts):
//
//     major * 1_000_000 + minor * 10_000 + patch * 100 + channel
//
// so each field has a ceiling, and Gradle refuses a version past it. Nothing else notices:
// npm, the tag, electron-builder and the updater feeds are all happy with 0.3.100 — only the
// Android job fails, first on the bump commit's CI run on main, then again in the Release run.
// Every bump path (npm run release, the Prepare release workflow, a hand `npm version`) and
// the Release workflow's version check call this so the version is refused before it lands.
//
//   node .github/scripts/version-limits.mjs <version>    exit 1 with the problem, silent when fine

import { pathToFileURL } from 'node:url'

export const LIMITS = Object.freeze({ major: 2100, minor: 99, patch: 99 })

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Explains why `version` cannot become an Android versionCode, or returns null when it can.
 * The message names the bump that gets past the ceiling, so the caller can print it as-is.
 */
export function androidVersionCodeProblem(version) {
  const match = SEMVER.exec(String(version))
  if (!match) return `"${version}" is not a semver string (major.minor.patch[-prerelease])`
  const [major, minor, patch] = match.slice(1, 4).map(Number)
  const over = []
  if (major > LIMITS.major) over.push(`major ${major} > ${LIMITS.major}`)
  if (minor > LIMITS.minor) over.push(`minor ${minor} > ${LIMITS.minor}`)
  if (patch > LIMITS.patch) over.push(`patch ${patch} > ${LIMITS.patch}`)
  if (over.length === 0) return null
  const advice =
    patch > LIMITS.patch && minor < LIMITS.minor
      ? ` Bump minor instead: ${major}.${minor + 1}.0.`
      : minor > LIMITS.minor && major < LIMITS.major
        ? ` Bump major instead: ${major + 1}.0.0.`
        : ''
  return (
    `${version} cannot be built for Android: ${over.join(', ')} ` +
    `(versionCode = major*1e6 + minor*1e4 + patch*100 + channel; see android/app/build.gradle.kts).${advice}`
  )
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const version = process.argv[2]
  if (!version) {
    console.error('usage: node .github/scripts/version-limits.mjs <version>')
    process.exit(2)
  }
  const problem = androidVersionCodeProblem(version)
  if (problem) {
    console.error(process.env.GITHUB_ACTIONS ? `::error::${problem}` : `error: ${problem}`)
    process.exit(1)
  }
}
