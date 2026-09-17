/**
 * Install orchestration: CRX (verified) or zip (unsigned sideload) bytes in, a validated,
 * localised package with lazily-decompressed files out. Persistence stays with the host: Electron
 * writes the files with `node:fs`, Android through its Kotlin bridge (see `writeExtensionFiles`).
 *
 * Why an in-memory archive with lazy entries rather than a streaming sink: a CRX3 signature covers
 * the whole archive, so nothing may be written before every byte has been read and verified. Once
 * the bytes are in memory anyway, decompressing one entry at a time on demand keeps the peak at
 * "compressed package + one file" (a 30 MB Grammarly package never needs 60 MB), and the host can
 * stream entries straight to disk in whatever order it likes.
 */
import {
  base64Decode,
  base64Encode,
  extensionIdFromPublicKey,
  extensionIdFromSeed,
  utf8Decode,
  utf8Encode
} from './bytes'
import { verifyCrx, type CrxPublisher } from './crx'
import {
  buildMessageCatalog,
  compareVersions,
  localeFallbackChain,
  localizeManifest,
  parseManifest,
  stripJsonComments,
  validateManifest,
  type ExtensionManifest,
  type LocaleMessages,
  type ManifestIssue
} from './manifest'
import {
  STORE_UPDATE_URLS,
  StoreError,
  fetchUpdateCheck,
  storeForEndpoint,
  updateCheckUrl,
  type OmahaApp,
  type StoreFetch,
  type StoreId,
  type StoreRequestOptions
} from './store'
import { readZip, type ZipArchive, type ZipEntry, type ZipLimits } from './zip'

export type InstallErrorCode =
  'manifest-missing' | 'manifest-invalid' | 'locale-missing' | 'id-mismatch' | 'key-invalid'

export class InstallError extends Error {
  constructor(
    readonly code: InstallErrorCode,
    message: string,
    readonly issues: ManifestIssue[] = []
  ) {
    super(message)
    this.name = 'InstallError'
  }
}

export interface ExtensionFile {
  /** Path relative to the extension root, forward slashes. */
  path: string
  size: number
  /** Decompresses and CRC-checks the file; call once and hand the bytes to the host. */
  bytes(): Promise<Uint8Array>
}

export interface ExtensionPackage {
  id: string
  version: string
  /** Validated manifest with `__MSG_` references resolved for the requested locale. */
  manifest: ExtensionManifest
  /** The manifest as the developer wrote it (comments stripped), before localisation. */
  rawManifest: Record<string, unknown>
  /**
   * Every file to persist. `manifest.json` carries the developer's public key (`key`) for signed
   * packages, as Chrome's own unpacker does, so hosts derive the same extension id on load.
   */
  files: ExtensionFile[]
  /** Directory entries the archive listed, relative to the extension root, trailing slash. */
  directories: string[]
  /** Sum of uncompressed file sizes. */
  totalSize: number
  signed: boolean
  publisher: CrxPublisher
  /** Developer DER SPKI for signed packages, or the key from `manifest.key`, or null. */
  publicKey: Uint8Array | null
  /** Manifest and packaging warnings worth surfacing in a management UI. */
  warnings: ManifestIssue[]
  /** The top-level folder that wrapped the extension in a sideloaded zip (`''` when none). */
  rootPrefix: string
}

export interface InstallOptions {
  /** UI locale (BCP 47 or `_locales` form) used to localise the manifest; default locale if omitted. */
  locale?: string | null
  limits?: Partial<ZipLimits>
  /** Fail unless the package's id is exactly this one (the id the user asked to install). */
  expectedId?: string
}

export interface ZipInstallOptions extends InstallOptions {
  /**
   * Seed for the extension id when the manifest has no `key`: Chrome hashes the install path for
   * unpacked extensions; hosts should pass something equally stable (the destination folder).
   */
  idSeed: string | Uint8Array
}

const MANIFEST_NAME = 'manifest.json'
const LOCALES_DIR = '_locales/'

/** Verifies a CRX3 and prepares its contents; throws `CrxError`, `ZipError` or `InstallError`. */
export async function installFromCrx(
  bytes: Uint8Array,
  options: InstallOptions = {}
): Promise<ExtensionPackage> {
  const verified = await verifyCrx(bytes)
  if (options.expectedId && verified.id !== options.expectedId) {
    throw new InstallError(
      'id-mismatch',
      `Package is ${verified.id} but ${options.expectedId} was requested`
    )
  }
  const archive = await readZip(verified.zip, options.limits)
  return buildPackage(archive, {
    id: verified.id,
    publicKey: verified.publicKey,
    publisher: verified.publisher,
    signed: true,
    locale: options.locale ?? null
  })
}

/**
 * Prepares an unsigned zip (GitHub release archives, developer builds). The id comes from
 * `manifest.key` when present, otherwise from `idSeed`, mirroring Chrome's unpacked-extension ids.
 */
export async function installFromZip(
  bytes: Uint8Array,
  options: ZipInstallOptions
): Promise<ExtensionPackage> {
  const archive = await readZip(bytes, options.limits)
  const located = locateManifest(archive)
  const parsed = await readManifest(located.entry)
  let publicKey: Uint8Array | null = null
  let id: string
  if (typeof parsed.raw.key === 'string') {
    try {
      publicKey = base64Decode(parsed.raw.key)
    } catch {
      throw new InstallError('key-invalid', 'manifest.json has a key that is not base64')
    }
    id = await extensionIdFromPublicKey(publicKey)
  } else {
    id = await extensionIdFromSeed(options.idSeed)
  }
  if (options.expectedId && id !== options.expectedId) {
    throw new InstallError(
      'id-mismatch',
      `Package is ${id} but ${options.expectedId} was requested`
    )
  }
  return buildPackage(archive, {
    id,
    publicKey,
    publisher: 'unknown',
    signed: false,
    locale: options.locale ?? null,
    located,
    parsed
  })
}

interface PackageSource {
  id: string
  publicKey: Uint8Array | null
  publisher: CrxPublisher
  signed: boolean
  locale: string | null
  located?: LocatedManifest
  parsed?: ParsedManifest
}

interface LocatedManifest {
  entry: ZipEntry
  rootPrefix: string
}

interface ParsedManifest {
  manifest: ExtensionManifest
  raw: Record<string, unknown>
  warnings: ManifestIssue[]
}

function locateManifest(archive: ZipArchive): LocatedManifest {
  const direct = archive.get(MANIFEST_NAME)
  if (direct) return { entry: direct, rootPrefix: '' }
  // A zip that wraps the extension in a single top-level folder (GitHub release archives do this).
  const tops = new Set<string>()
  for (const entry of archive.entries) {
    const slash = entry.path.indexOf('/')
    if (slash < 0) {
      tops.clear()
      break
    }
    tops.add(entry.path.slice(0, slash + 1))
    if (tops.size > 1) break
  }
  if (tops.size === 1) {
    const prefix = [...tops][0]
    const nested = archive.get(`${prefix}${MANIFEST_NAME}`)
    if (nested) return { entry: nested, rootPrefix: prefix }
  }
  throw new InstallError('manifest-missing', 'The package has no manifest.json at its root')
}

async function readManifest(entry: ZipEntry): Promise<ParsedManifest> {
  let text: string
  try {
    text = utf8Decode(await entry.bytes())
  } catch {
    throw new InstallError('manifest-invalid', 'manifest.json is not valid UTF-8')
  }
  const result = parseManifest(text)
  if (!result.manifest || !result.raw) {
    throw new InstallError(
      'manifest-invalid',
      `manifest.json is invalid: ${result.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')}`,
      result.errors
    )
  }
  return { manifest: result.manifest, raw: result.raw, warnings: result.warnings }
}

async function buildPackage(archive: ZipArchive, source: PackageSource): Promise<ExtensionPackage> {
  const located = source.located ?? locateManifest(archive)
  const parsed = source.parsed ?? (await readManifest(located.entry))
  const { rootPrefix } = located
  const warnings = [...parsed.warnings]

  const relative = (path: string): string => path.slice(rootPrefix.length)
  const inRoot = (entry: { path: string }): boolean =>
    rootPrefix === '' || entry.path.startsWith(rootPrefix)
  const entries = archive.entries.filter(inRoot)
  const directories = archive.directories
    .filter((d) => inRoot({ path: d }))
    .map(relative)
    .filter((d) => d.length > 0)

  for (const entry of entries) {
    const path = relative(entry.path)
    const top = path.split('/')[0]
    if (top.startsWith('_') && top !== '_locales' && top !== '_metadata') {
      warnings.push({ path, message: 'Names starting with "_" are reserved by Chrome' })
    }
  }

  const localized = await localize(archive, parsed, rootPrefix, source.locale, warnings)

  // Chrome's unpacker rewrites manifest.json with the package's public key; do the same so hosts
  // that derive ids from `key` (Electron's loadExtension included) land on the store id.
  let manifestOverride: Uint8Array | null = null
  if (source.signed && source.publicKey) {
    const withKey = { ...parsed.raw, key: base64Encode(source.publicKey) }
    manifestOverride = utf8Encode(JSON.stringify(withKey, null, 2))
  }

  let totalSize = 0
  const files: ExtensionFile[] = entries.map((entry) => {
    const path = relative(entry.path)
    if (path === MANIFEST_NAME && manifestOverride) {
      const bytes = manifestOverride
      totalSize += bytes.length
      return { path, size: bytes.length, bytes: async () => bytes }
    }
    totalSize += entry.size
    return { path, size: entry.size, bytes: () => entry.bytes() }
  })

  return {
    id: source.id,
    version: parsed.manifest.version,
    manifest: localized,
    rawManifest: parsed.raw,
    files,
    directories,
    totalSize,
    signed: source.signed,
    publisher: source.publisher,
    publicKey: source.publicKey,
    warnings,
    rootPrefix
  }
}

async function localize(
  archive: ZipArchive,
  parsed: ParsedManifest,
  rootPrefix: string,
  locale: string | null,
  warnings: ManifestIssue[]
): Promise<ExtensionManifest> {
  const defaultLocale = parsed.manifest.default_locale
  const localesPrefix = `${rootPrefix}${LOCALES_DIR}`
  const hasLocales =
    archive.entries.some((e) => e.path.startsWith(localesPrefix)) ||
    archive.directories.some((d) => d.startsWith(localesPrefix))
  if (!defaultLocale) {
    if (hasLocales) {
      throw new InstallError(
        'locale-missing',
        "The package has a _locales folder but manifest.json does not specify 'default_locale'"
      )
    }
    return parsed.manifest
  }
  const messagesFor = async (code: string): Promise<LocaleMessages | null> => {
    const entry = archive.get(`${localesPrefix}${code}/messages.json`)
    if (!entry) return null
    try {
      const parsedMessages: unknown = JSON.parse(stripJsonComments(utf8Decode(await entry.bytes())))
      if (
        typeof parsedMessages !== 'object' ||
        parsedMessages === null ||
        Array.isArray(parsedMessages)
      ) {
        warnings.push({ path: entry.path, message: 'messages.json is not an object' })
        return null
      }
      return parsedMessages as LocaleMessages
    } catch (error) {
      warnings.push({
        path: entry.path,
        message: `messages.json could not be read: ${(error as Error).message}`
      })
      return null
    }
  }
  const chain = localeFallbackChain(locale, defaultLocale)
  const bundles = await Promise.all(chain.map(messagesFor))
  const defaultIndex = chain.indexOf(localeFallbackChain(null, defaultLocale)[0])
  if (bundles[defaultIndex] === null) {
    throw new InstallError(
      'locale-missing',
      `manifest.json names '${defaultLocale}' as default_locale but _locales/${defaultLocale}/messages.json is missing`
    )
  }
  const catalog = buildMessageCatalog(bundles)
  const result = localizeManifest(parsed.raw, catalog)
  for (const name of result.missing) {
    warnings.push({
      path: 'default_locale',
      message: `Message '${name}' is not defined in any locale`
    })
  }
  const revalidated = validateManifest(result.manifest)
  return revalidated.manifest ?? parsed.manifest
}

// ---------------------------------------------------------------------------
// Host persistence seam
// ---------------------------------------------------------------------------

/** What a host must provide to persist a package; parent directories are the host's business. */
export interface ExtensionFilesSink {
  writeFile(path: string, bytes: Uint8Array): Promise<void>
}

/** Writes every file of a package through the sink, one decompressed entry at a time. */
export async function writeExtensionFiles(
  pkg: Pick<ExtensionPackage, 'files'>,
  sink: ExtensionFilesSink
): Promise<void> {
  for (const file of pkg.files) await sink.writeFile(file.path, await file.bytes())
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export interface UpdateSource {
  id: string
  /** Installed version. */
  version: string
  /** `manifest.update_url`, when the extension declares one. */
  updateUrl?: string | null
  /** The store the extension was installed from, used when `updateUrl` is absent. */
  store?: StoreId | null
}

export type UpdateCheckResult =
  | {
      status: 'update-available'
      version: string
      codebase: string
      sha256: string | null
      size: number | null
    }
  | { status: 'up-to-date' }
  | { status: 'error'; reason: string }

function endpointFor(source: UpdateSource): string | null {
  if (source.updateUrl) return source.updateUrl
  if (source.store) return STORE_UPDATE_URLS[source.store]
  return null
}

/**
 * Checks a batch of extensions for updates, one request per update endpoint (Omaha accepts many
 * `x=` parameters). Results are keyed by extension id; network or protocol failures become
 * `error` results for every extension on that endpoint instead of throwing.
 */
export async function checkForUpdates(
  fetch: StoreFetch,
  sources: readonly UpdateSource[],
  options: StoreRequestOptions
): Promise<Map<string, UpdateCheckResult>> {
  const results = new Map<string, UpdateCheckResult>()
  const groups = new Map<string, UpdateSource[]>()
  for (const source of sources) {
    const endpoint = endpointFor(source)
    if (!endpoint) {
      results.set(source.id, { status: 'error', reason: 'no-update-source' })
      continue
    }
    const key = storeForEndpoint(endpoint) ?? endpoint
    const group = groups.get(key) ?? []
    group.push(source)
    groups.set(key, group)
  }
  await Promise.all(
    [...groups.entries()].map(async ([endpoint, group]) => {
      let apps: OmahaApp[]
      try {
        const url = updateCheckUrl(
          endpoint,
          group.map((s) => ({ id: s.id, version: s.version })),
          options
        )
        apps = await fetchUpdateCheck(fetch, url)
      } catch (error) {
        const reason = error instanceof StoreError ? error.code : 'network'
        for (const source of group) results.set(source.id, { status: 'error', reason })
        return
      }
      for (const source of group) {
        const app = apps.find((a) => a.appId === source.id)
        results.set(source.id, interpret(app, source.version))
      }
    })
  )
  return results
}

/** Convenience for a single extension. */
export async function checkForUpdate(
  fetch: StoreFetch,
  source: UpdateSource,
  options: StoreRequestOptions
): Promise<UpdateCheckResult> {
  const results = await checkForUpdates(fetch, [source], options)
  return results.get(source.id) ?? { status: 'error', reason: 'no-response' }
}

function interpret(app: OmahaApp | undefined, currentVersion: string): UpdateCheckResult {
  if (!app) return { status: 'error', reason: 'not-in-response' }
  if (app.status === 'noupdate') return { status: 'up-to-date' }
  if (app.status !== 'ok' || !app.update) return { status: 'error', reason: app.status }
  let newer: boolean
  try {
    newer = compareVersions(app.update.version, currentVersion) > 0
  } catch {
    return { status: 'error', reason: 'bad-version' }
  }
  if (!newer) return { status: 'up-to-date' }
  return { status: 'update-available', ...app.update }
}
