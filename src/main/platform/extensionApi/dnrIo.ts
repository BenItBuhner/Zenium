import { promises as fs } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parsePersistedState } from '../../../core/extensions/dnr/persist'
import type { DnrPersistedState, DnrStateIO } from '../../../core/extensions/dnr/state'

export { parsePersistedState }

export interface DnrIoOptions {
  /** The extension's install directory (static `rule_resources` paths resolve against it). */
  installDir: string
  /** Where the extension's persisted declarativeNetRequest record lives. */
  stateFile: string
}

/**
 * `DnrStateIO` over the file system: ruleset files are read from the install directory (a path
 * that escapes it is refused), the persisted record is one JSON document written atomically
 * (temp file, then rename) like every other Zenium store. Pure Node, so it is testable without
 * Electron; `DeclarativeNetRequestApi` adds the Electron-side hooks (tab checks, badge).
 */
export function createDnrFileIO(options: DnrIoOptions): DnrStateIO {
  const root = resolve(options.installDir)
  let writes = 0
  return {
    async readFile(path: string): Promise<string> {
      const target = resolve(root, path.replace(/^\/+/, ''))
      const rel = relative(root, target)
      if (rel.startsWith('..') || rel.startsWith(sep) || target === root) {
        throw new Error(`Ruleset path escapes the extension: ${path}`)
      }
      return fs.readFile(target, 'utf8')
    },
    async loadState(): Promise<DnrPersistedState | undefined> {
      let text: string
      try {
        text = await fs.readFile(options.stateFile, 'utf8')
      } catch {
        return undefined
      }
      return parsePersistedState(text)
    },
    async saveState(state: DnrPersistedState): Promise<void> {
      await fs.mkdir(dirname(options.stateFile), { recursive: true })
      const tmp = `${options.stateFile}.${process.pid}.${++writes}.tmp`
      await fs.writeFile(tmp, JSON.stringify(state), 'utf8')
      await fs.rename(tmp, options.stateFile)
    }
  }
}

/** `<stateDir>/<extensionId>.json`: the record's location, next to the extension registry. */
export function dnrStateFile(stateDir: string, extensionId: string): string {
  return join(stateDir, `${extensionId}.json`)
}
