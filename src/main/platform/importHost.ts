import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import type {
  ImportDatabase,
  ImportFileKind,
  ImportHost,
  ImportTempCopy
} from '../../core/platform'

/**
 * The desktop's file access for `core/import` (ID-23): other browsers' profiles read from disk,
 * their SQLite databases copied into a temp directory and opened read-only with `node:sqlite`
 * (the Node bundled with Electron ships it; no native module), and the OS keyring entry Chrome
 * seals its passwords with, asked for through the platform's own command-line tools –
 * `secret-tool` (libsecret) on Linux, `security` (the Keychain) on macOS. Windows has nothing to
 * ask: DPAPI only answers the user's own processes, so the core records the limit instead.
 */

const TEMP_PREFIX = 'zenium-import-'
/** The Keychain may put a permission dialog in front of the user; give them time to answer it. */
const SECRET_TIMEOUT_MS = 60_000

type Exec = (command: string, args: string[]) => Promise<string | null>

export interface ElectronImportHostOptions {
  homeDir?: string
  env?: Readonly<Record<string, string | undefined>>
  tempRoot?: string
  os?: NodeJS.Platform
  exec?: Exec
}

interface SqliteModule {
  DatabaseSync: new (
    path: string,
    options: { readOnly: boolean }
  ) => {
    prepare(sql: string): { setReadBigInts(on: boolean): void; all(): unknown[] }
    close(): void
  }
}

/** `node:sqlite` fetched at run time: the bundler leaves the call alone and old Nodes say so. */
function sqliteModule(): SqliteModule {
  const loaded = process.getBuiltinModule?.('node:sqlite') as SqliteModule | undefined
  if (!loaded) throw new Error('This build of Zenium cannot read SQLite databases.')
  return loaded
}

const KEYRING_QUERIES: Record<'chrome' | 'chromium' | 'edge', string[][]> = {
  chrome: [['application', 'chrome']],
  chromium: [['application', 'chromium']],
  edge: [
    ['application', 'microsoft-edge'],
    ['application', 'edge']
  ]
}

const KEYCHAIN_ITEMS: Record<'chrome' | 'chromium' | 'edge', { service: string; account: string }> =
  {
    chrome: { service: 'Chrome Safe Storage', account: 'Chrome' },
    chromium: { service: 'Chromium Safe Storage', account: 'Chromium' },
    edge: { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' }
  }

export class ElectronImportHost implements ImportHost {
  readonly homeDir: string
  readonly env: Readonly<Record<string, string | undefined>>
  private readonly tempRoot: string
  private readonly os: NodeJS.Platform
  private readonly exec: Exec

  constructor(options: ElectronImportHostOptions = {}) {
    this.homeDir = options.homeDir ?? homedir()
    this.env = options.env ?? process.env
    this.tempRoot = options.tempRoot ?? tmpdir()
    this.os = options.os ?? process.platform
    this.exec = options.exec ?? runQuietly
  }

  async stat(path: string): Promise<ImportFileKind> {
    try {
      const info = await fs.lstat(path)
      if (info.isSymbolicLink()) return 'symlink'
      if (info.isDirectory()) return 'dir'
      return 'file'
    } catch {
      // Missing, or hidden behind a permission the process lacks (macOS without Full Disk Access
      // answers EPERM for Safari's files): either way there is nothing to read here.
      return 'missing'
    }
  }

  readText(path: string): Promise<string> {
    return fs.readFile(path, 'utf8')
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const buffer = await fs.readFile(path)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }

  async list(dir: string): Promise<string[]> {
    try {
      return (await fs.readdir(dir)).sort()
    } catch {
      return []
    }
  }

  async copyToTemp(paths: string[]): Promise<ImportTempCopy> {
    const dir = await fs.mkdtemp(join(this.tempRoot, TEMP_PREFIX))
    const copies: (string | null)[] = []
    try {
      for (const path of paths) {
        const target = join(dir, basename(path))
        try {
          await fs.copyFile(path, target)
          copies.push(target)
        } catch (error) {
          if (isMissing(error)) {
            copies.push(null)
            continue
          }
          throw error
        }
      }
    } catch (error) {
      // A copy the source browser refused: leave nothing behind, let the core name the browser.
      await this.removeTemp(dir)
      throw error
    }
    return { dir, copies }
  }

  async removeTemp(dir: string): Promise<void> {
    // Only ever remove what `copyToTemp` created.
    const root = resolve(this.tempRoot) + sep
    const target = resolve(dir)
    if (!target.startsWith(root) || !basename(target).startsWith(TEMP_PREFIX)) return
    await fs.rm(target, { recursive: true, force: true })
  }

  async openSqlite(path: string): Promise<ImportDatabase> {
    const { DatabaseSync } = sqliteModule()
    const db = new DatabaseSync(path, { readOnly: true })
    return {
      all: (sql) => {
        const statement = db.prepare(sql)
        // Chrome's WebKit microsecond stamps pass 2^53: integers come back as BigInts, exactly.
        statement.setReadBigInts(true)
        return statement.all() as Record<string, unknown>[]
      },
      close: () => db.close()
    }
  }

  async safeStorageSecret(browser: 'chrome' | 'chromium' | 'edge'): Promise<string | null> {
    if (this.os === 'linux') {
      for (const attributes of KEYRING_QUERIES[browser]) {
        const secret = await this.exec('secret-tool', ['lookup', ...attributes])
        if (secret) return secret
      }
      return null
    }
    if (this.os === 'darwin') {
      const item = KEYCHAIN_ITEMS[browser]
      return this.exec('security', [
        'find-generic-password',
        '-w',
        '-a',
        item.account,
        '-s',
        item.service
      ])
    }
    return null
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** The trimmed stdout of a command, or null when it is missing, fails or prints nothing. */
function runQuietly(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      { timeout: SECRET_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => {
        const text = error ? '' : String(stdout).replace(/\r?\n$/, '')
        resolvePromise(text ? text : null)
      }
    )
  })
}
