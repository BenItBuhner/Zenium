/**
 * On-disk layout of managed extension installs, Chrome style:
 *
 *     <root>/<id>/<version>/          the files Electron (or the WebView host) loads
 *     <root>/<id>/<version>_1/        a second install of the same version (Chrome does this too)
 *     <root>/.staging/<token>/        where a package is written before it becomes visible
 *
 * A package is written to a staging directory first and renamed into place in one step, so a
 * crash mid-install leaves a stale staging folder (swept on the next start) but never a
 * half-written extension the loader could pick up. Filesystem access is abstracted so the logic
 * is testable and shared with the Android host.
 */

export interface LayoutFs {
  /** Creates the directory and its parents; succeeds when it already exists. */
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Removes a file or a directory tree; succeeds when it does not exist. */
  remove(path: string): Promise<void>
  /** Entry names of a directory; `[]` when it does not exist. */
  list(path: string): Promise<string[]>
  exists(path: string): Promise<boolean>
  join(...parts: string[]): string
}

export const STAGING_DIR = '.staging'

const MAX_VERSION_DIR_ATTEMPTS = 100

/** A version is safe as a directory name; anything else (unpacked folders can be odd) is escaped. */
export function versionDirName(version: string): string {
  const safe = version.replace(/[^0-9A-Za-z._-]/g, '_')
  return safe.length > 0 && safe !== '.' && safe !== '..' ? safe : 'unversioned'
}

/**
 * The first free `<root>/<id>/<version>[_n]` directory, like Chrome's `GetVersionDir`: a
 * reinstall of the same version must never write into the folder a running extension uses.
 */
export async function pickVersionDir(
  fs: LayoutFs,
  root: string,
  id: string,
  version: string
): Promise<string> {
  const base = versionDirName(version)
  for (let attempt = 0; attempt < MAX_VERSION_DIR_ATTEMPTS; attempt++) {
    const candidate = fs.join(root, id, attempt === 0 ? base : `${base}_${attempt}`)
    if (!(await fs.exists(candidate))) return candidate
  }
  throw new Error(`Too many installs of ${id} ${version}`)
}

let stagingSeq = 0

function stagingToken(): string {
  stagingSeq += 1
  return `${Date.now().toString(36)}-${stagingSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Writes a package through `write(stagingDir)` and moves it to its final version directory,
 * which is returned. The staging directory is removed again if writing fails.
 */
export async function installIntoLayout(
  fs: LayoutFs,
  root: string,
  id: string,
  version: string,
  write: (dir: string) => Promise<void>
): Promise<string> {
  const staging = fs.join(root, STAGING_DIR, stagingToken())
  await fs.mkdir(staging)
  try {
    await write(staging)
    await fs.mkdir(fs.join(root, id))
    const target = await pickVersionDir(fs, root, id, version)
    await fs.rename(staging, target)
    return target
  } catch (error) {
    await fs.remove(staging).catch(() => undefined)
    throw error
  }
}

/** Removes every version directory of `id` except `keep`; returns what was removed. */
export async function pruneOtherVersions(
  fs: LayoutFs,
  root: string,
  id: string,
  keep: string
): Promise<string[]> {
  const dir = fs.join(root, id)
  const removed: string[] = []
  for (const name of await fs.list(dir)) {
    const path = fs.join(dir, name)
    if (path === keep) continue
    await fs.remove(path)
    removed.push(path)
  }
  return removed
}

/** Removes the whole `<root>/<id>` tree (uninstall). */
export async function removeInstall(fs: LayoutFs, root: string, id: string): Promise<void> {
  await fs.remove(fs.join(root, id))
}

/** Sweeps staging folders an interrupted install left behind. */
export async function sweepStaging(fs: LayoutFs, root: string): Promise<string[]> {
  const dir = fs.join(root, STAGING_DIR)
  const removed: string[] = []
  for (const name of await fs.list(dir)) {
    const path = fs.join(dir, name)
    await fs.remove(path)
    removed.push(path)
  }
  return removed
}

/** True when `path` lies inside the managed root (unpacked folders live wherever the user keeps them). */
export function isManagedPath(root: string, path: string): boolean {
  return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)
}
