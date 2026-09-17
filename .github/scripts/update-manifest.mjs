// The machine-readable side of a release: `update-manifest.json`, which the browser's updater
// reads (src/shared/updates.ts parses exactly this shape), plus its optional detached ed25519
// signature. Run from the repository root.
//
//   node .github/scripts/update-manifest.mjs build        write the manifest (and .sig when a key is set)
//   node .github/scripts/update-manifest.mjs keygen       print a fresh signing key pair
//   node .github/scripts/update-manifest.mjs public-key   print the public key of UPDATE_MANIFEST_SIGNING_KEY
//   node .github/scripts/update-manifest.mjs verify       check update-manifest.json against its .sig
//
// build reads:
//   RELEASE_TAG, RELEASE_VERSION        what is being released (vX.Y.Z / X.Y.Z)
//   GITHUB_REPOSITORY, GITHUB_SHA        owner/name and the commit
//   ASSETS_DIR                           packages to describe (default release/assets)
//   META_DIR                             per-platform build info JSON (default release/meta)
//   PUBLISHED_AT                         ISO timestamp (default: now)
//   UPDATE_MANIFEST_SIGNING_KEY          ed25519 private key, PKCS#8 PEM (or base64 of it); optional
//   ALLOW_INCOMPLETE                     "true" to tolerate missing packages
// verify reads:
//   UPDATE_MANIFEST_PUBLIC_KEY           base64 raw public key; defaults to the one named in the .sig
import {
  appendFileSync,
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from 'node:crypto'

const MANIFEST_FILE = 'update-manifest.json'
const SIGNATURE_FILE = 'update-manifest.json.sig'
const SCHEMA_VERSION = 1

/** How a package file name maps to the target it serves; mirrors the CATALOG in release-notes.mjs. */
const ASSET_KINDS = [
  { test: /-x64-setup\.exe$/, os: 'windows', arch: 'x64', kind: 'nsis', meta: 'windows-x64' },
  { test: /-arm64-setup\.exe$/, os: 'windows', arch: 'arm64', kind: 'nsis', meta: 'windows-arm64' },
  { test: /-arm64\.dmg$/, os: 'macos', arch: 'arm64', kind: 'dmg', meta: 'macos' },
  { test: /-x64\.dmg$/, os: 'macos', arch: 'x64', kind: 'dmg', meta: 'macos' },
  { test: /-arm64\.zip$/, os: 'macos', arch: 'arm64', kind: 'zip', meta: 'macos' },
  { test: /-x64\.zip$/, os: 'macos', arch: 'x64', kind: 'zip', meta: 'macos' },
  { test: /-x86_64\.AppImage$/, os: 'linux', arch: 'x64', kind: 'appimage', meta: 'linux-x64' },
  { test: /-arm64\.AppImage$/, os: 'linux', arch: 'arm64', kind: 'appimage', meta: 'linux-arm64' },
  { test: /_amd64\.deb$/, os: 'linux', arch: 'x64', kind: 'deb', meta: 'linux-x64' },
  { test: /_arm64\.deb$/, os: 'linux', arch: 'arm64', kind: 'deb', meta: 'linux-arm64' },
  { test: /\.apk$/, os: 'android', arch: 'universal', kind: 'apk', meta: 'android' }
]

/** electron-updater feed files by the target that reads them. */
const FEEDS = {
  'latest.yml': 'windows-x64',
  'latest-arm64.yml': 'windows-arm64',
  'latest-mac.yml': 'macos',
  'latest-linux.yml': 'linux-x64',
  'latest-linux-arm64.yml': 'linux-arm64'
}

/** Files that travel with a release but are not packages. */
const NOT_A_PACKAGE = /(\.yml|\.blockmap|\.sig|\.txt|\.json)$/

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

function required(name) {
  const value = (process.env[name] ?? '').trim()
  if (!value) fail(`${name} is required`)
  return value
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Accept the PEM itself or a base64 wrapping of it (handy for single-line secrets). */
function loadPrivateKey(text) {
  let pem = text.trim()
  if (!pem.includes('-----BEGIN')) {
    try {
      pem = Buffer.from(pem, 'base64').toString('utf8').trim()
    } catch {
      /* fall through to the error below */
    }
  }
  if (!pem.includes('-----BEGIN')) fail('UPDATE_MANIFEST_SIGNING_KEY is not a PEM private key')
  const key = createPrivateKey(pem)
  if (key.asymmetricKeyType !== 'ed25519')
    fail(`UPDATE_MANIFEST_SIGNING_KEY is a ${key.asymmetricKeyType} key; ed25519 is required`)
  return key
}

/** Raw 32-byte ed25519 public key (base64) – what the app pins and what the .sig names. */
function rawPublicKey(key) {
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' })
  return spki.subarray(spki.length - 32).toString('base64')
}

function rawToSpki(base64) {
  const raw = Buffer.from(base64, 'base64')
  if (raw.length !== 32) fail('public key must be 32 raw bytes (base64)')
  // SPKI prefix for an Ed25519 key: SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING }
  const prefix = Buffer.from('302a300506032b6570032100', 'hex')
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' })
}

function signManifest(manifestText, key) {
  return JSON.stringify(
    {
      algorithm: 'ed25519',
      publicKey: rawPublicKey(key),
      signature: sign(null, Buffer.from(manifestText, 'utf8'), key).toString('base64')
    },
    null,
    2
  )
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function keygen() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  console.log('# Private key → repository secret UPDATE_MANIFEST_SIGNING_KEY (keep it out of git):')
  console.log(pem.trim())
  console.log()
  console.log(
    '# Public key → built into the app by the Release workflow (VITE_ZEN_UPDATE_PUBLIC_KEY):'
  )
  console.log(rawPublicKey(privateKey))
}

function publicKey() {
  const key = loadPrivateKey(required('UPDATE_MANIFEST_SIGNING_KEY'))
  process.stdout.write(`${rawPublicKey(key)}\n`)
}

function verifyCommand() {
  const dir = process.env.ASSETS_DIR || 'release/assets'
  const manifestPath = join(dir, MANIFEST_FILE)
  const signaturePath = join(dir, SIGNATURE_FILE)
  if (!existsSync(manifestPath)) fail(`${manifestPath} does not exist`)
  if (!existsSync(signaturePath)) fail(`${signaturePath} does not exist (unsigned release)`)
  const envelope = JSON.parse(readFileSync(signaturePath, 'utf8'))
  const expected = (process.env.UPDATE_MANIFEST_PUBLIC_KEY ?? '').trim() || envelope.publicKey
  if (envelope.algorithm !== 'ed25519')
    fail(`unsupported signature algorithm ${envelope.algorithm}`)
  if (envelope.publicKey !== expected) fail('the signature names a different public key')
  const ok = verify(
    null,
    readFileSync(manifestPath),
    rawToSpki(expected),
    Buffer.from(envelope.signature, 'base64')
  )
  if (!ok) fail('signature does not verify')
  console.log(`OK: ${MANIFEST_FILE} is signed by ${expected}`)
}

async function build() {
  const tag = required('RELEASE_TAG')
  const version = required('RELEASE_VERSION')
  const repo = required('GITHUB_REPOSITORY')
  const commit = (process.env.GITHUB_SHA ?? '').trim()
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
  const assetsDir = process.env.ASSETS_DIR || 'release/assets'
  const metaDir = process.env.META_DIR || 'release/meta'
  const allowIncomplete = (process.env.ALLOW_INCOMPLETE ?? 'false') === 'true'
  const publishedAt = (process.env.PUBLISHED_AT ?? '').trim() || new Date().toISOString()
  if (tag !== `v${version}`) fail(`RELEASE_TAG ${tag} does not match RELEASE_VERSION ${version}`)

  const downloadBase = `${serverUrl}/${repo}/releases/download/${encodeURIComponent(tag)}`
  const meta = {}
  if (existsSync(metaDir)) {
    for (const file of readdirSync(metaDir)) {
      if (!file.endsWith('.json')) continue
      const info = JSON.parse(readFileSync(join(metaDir, file), 'utf8'))
      meta[info.platform] = info
    }
  }

  const files = readdirSync(assetsDir).sort()
  const assets = []
  const unknown = []
  for (const name of files) {
    if (name === MANIFEST_FILE || name === SIGNATURE_FILE) continue
    const entry = ASSET_KINDS.find((k) => k.test.test(name))
    if (!entry) {
      if (!NOT_A_PACKAGE.test(name)) unknown.push(name)
      continue
    }
    const path = join(assetsDir, name)
    const info = meta[entry.meta] ?? {}
    const asset = {
      os: entry.os,
      arch: entry.arch,
      kind: entry.kind,
      name,
      url: `${downloadBase}/${encodeURIComponent(name)}`,
      size: statSync(path).size,
      sha256: await sha256(path),
      signed: entry.os === 'android' ? info.signing === 'release' : info.signed === true
    }
    if (entry.os === 'macos') asset.notarized = info.notarized === true
    if (entry.os === 'android') {
      asset.signer = /^[0-9a-f]{64}$/i.test(info.signer ?? '') ? info.signer.toLowerCase() : null
      // The applicationId: an installed app with another one cannot be upgraded by this APK, it
      // gets a second app instead (the rename from app.zen.chromium to io.github.benitbuhner.zenium).
      asset.packageName =
        typeof info.packageName === 'string' &&
        /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(info.packageName)
          ? info.packageName
          : null
    }
    assets.push(asset)
  }
  if (unknown.length > 0)
    console.warn(`::warning::Not described in the manifest: ${unknown.join(', ')}`)
  const missing = ASSET_KINDS.filter(
    (k) => !assets.some((a) => a.os === k.os && a.arch === k.arch && a.kind === k.kind)
  ).map((k) => `${k.os}/${k.arch}/${k.kind}`)
  if (missing.length > 0) {
    const message = `Release is missing packages: ${missing.join(', ')}`
    if (allowIncomplete) console.warn(`::warning::${message}`)
    else fail(message)
  }
  if (assets.length === 0) fail(`No packages found in ${assetsDir}`)

  const feeds = {}
  for (const [file, target] of Object.entries(FEEDS)) {
    if (files.includes(file)) feeds[target] = `${downloadBase}/${file}`
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    name: 'Zenium',
    version,
    tag,
    prerelease: version.includes('-'),
    publishedAt,
    commit,
    releaseUrl: `${serverUrl}/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    notesUrl: `${serverUrl}/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    checksumsUrl: `${downloadBase}/SHA256SUMS.txt`,
    assets,
    feeds
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileSync(join(assetsDir, MANIFEST_FILE), manifestText)
  console.log(
    `Wrote ${join(assetsDir, MANIFEST_FILE)} (${assets.length} packages, ${Object.keys(feeds).length} feeds)`
  )

  const keyText = (process.env.UPDATE_MANIFEST_SIGNING_KEY ?? '').trim()
  let signedBy = null
  if (keyText) {
    const key = loadPrivateKey(keyText)
    writeFileSync(join(assetsDir, SIGNATURE_FILE), `${signManifest(manifestText, key)}\n`)
    signedBy = rawPublicKey(key)
    console.log(`Signed with ${signedBy} → ${join(assetsDir, SIGNATURE_FILE)}`)
  } else {
    console.warn(
      '::notice::UPDATE_MANIFEST_SIGNING_KEY is not set; the update manifest is published unsigned (the app then relies on HTTPS and per-file SHA-256 only)'
    )
  }

  summary(
    [
      `### Update manifest`,
      '',
      `| | |`,
      `| --- | --- |`,
      `| Packages | ${assets.length} |`,
      `| Feeds | ${Object.keys(feeds).join(', ') || 'none'} |`,
      `| Signature | ${signedBy ? `ed25519, key \`${signedBy}\`` : 'unsigned'} |`,
      '',
      '```json',
      JSON.stringify(
        { ...manifest, assets: manifest.assets.map((a) => `${a.name} (${a.kind}, ${a.arch})`) },
        null,
        2
      ),
      '```'
    ].join('\n')
  )
}

const command = process.argv[2] ?? 'build'
switch (command) {
  case 'build':
    await build()
    break
  case 'keygen':
    keygen()
    break
  case 'public-key':
    publicKey()
    break
  case 'verify':
    verifyCommand()
    break
  default:
    fail(`Unknown command "${command}" (build | keygen | public-key | verify)`)
}
