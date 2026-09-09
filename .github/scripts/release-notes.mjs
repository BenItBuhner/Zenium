// Writes the body of a GitHub release: a download table with one row per package, install notes
// that reflect how each package was signed, verification instructions and GitHub's generated
// changelog. Also refuses to describe an incomplete release.
//
//   RELEASE_TAG, RELEASE_VERSION        what is being released
//   GITHUB_REPOSITORY                    owner/name
//   GITHUB_TOKEN                         used for the generate-notes API (optional)
//   ASSETS_DIR                           directory with the packages (default release/assets)
//   META_DIR                             directory with build-info JSON files (default release/meta)
//   NOTES_FILE                           where to write the markdown (default release/notes.md)
//   ALLOW_INCOMPLETE                     "true" to tolerate missing packages
import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  appendFileSync,
  existsSync
} from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const tag = required('RELEASE_TAG')
const version = required('RELEASE_VERSION')
const repo = required('GITHUB_REPOSITORY')
const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com'
const assetsDir = process.env.ASSETS_DIR || 'release/assets'
const metaDir = process.env.META_DIR || 'release/meta'
const notesFile = process.env.NOTES_FILE || 'release/notes.md'
const allowIncomplete = (process.env.ALLOW_INCOMPLETE ?? 'false') === 'true'

const downloadBase = `${serverUrl}/${repo}/releases/download/${tag}`
const CHECKSUMS = 'SHA256SUMS.txt'

/** Every package a complete release ships, in the order shown on the release page. */
const CATALOG = [
  {
    key: 'windows-x64',
    test: /-x64-setup\.exe$/,
    platform: 'Windows 10 / 11',
    arch: 'x64',
    kind: 'Installer'
  },
  {
    key: 'windows-arm64',
    test: /-arm64-setup\.exe$/,
    platform: 'Windows 11 on ARM',
    arch: 'arm64',
    kind: 'Installer'
  },
  {
    key: 'macos-arm64',
    test: /-arm64\.dmg$/,
    platform: 'macOS (Apple Silicon)',
    arch: 'arm64',
    kind: 'Disk image'
  },
  {
    key: 'macos-x64',
    test: /-x64\.dmg$/,
    platform: 'macOS (Intel)',
    arch: 'x64',
    kind: 'Disk image'
  },
  {
    key: 'linux-appimage-x64',
    test: /-x86_64\.AppImage$/,
    platform: 'Linux (AppImage)',
    arch: 'x64',
    kind: 'Portable'
  },
  {
    key: 'linux-appimage-arm64',
    test: /-arm64\.AppImage$/,
    platform: 'Linux (AppImage)',
    arch: 'arm64',
    kind: 'Portable'
  },
  {
    key: 'linux-deb-x64',
    test: /_amd64\.deb$/,
    platform: 'Debian / Ubuntu (.deb)',
    arch: 'x64',
    kind: 'Package'
  },
  {
    key: 'linux-deb-arm64',
    test: /_arm64\.deb$/,
    platform: 'Debian / Ubuntu (.deb)',
    arch: 'arm64',
    kind: 'Package'
  },
  { key: 'android', test: /\.apk$/, platform: 'Android 8.0+', arch: 'universal', kind: 'APK' }
]

function required(name) {
  const value = (process.env[name] ?? '').trim()
  if (!value) {
    console.error(`::error::${name} is required`)
    process.exit(1)
  }
  return value
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function link(file) {
  return `[${file}](${downloadBase}/${encodeURIComponent(file)})`
}

/** Parses "v1.2.3-beta.1" into something comparable; returns null for other tags. */
function parseTag(name) {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(name)
  if (!match) return null
  return {
    name,
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : null
  }
}

/** Semver precedence: numeric core, then a pre-release sorts below the final release. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
  }
  if (!a.pre && !b.pre) return 0
  if (!a.pre) return 1
  if (!b.pre) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < length; i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y)
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * The tag GitHub diffs the changelog against: the highest v* tag below the one being released.
 * A final release skips pre-release tags so its notes cover everything since the last final
 * release; a pre-release compares against whatever came right before it.
 */
function previousTag() {
  const current = parseTag(tag)
  if (!current) return null
  let tags
  try {
    tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n')
  } catch {
    return null
  }
  const lower = tags
    .map((name) => parseTag(name.trim()))
    .filter((parsed) => parsed && compareVersions(parsed, current) < 0)
    .sort(compareVersions)
  const finals = lower.filter((parsed) => !parsed.pre)
  const candidates = !current.pre && finals.length > 0 ? finals : lower
  return candidates.length > 0 ? candidates[candidates.length - 1].name : null
}

async function generatedNotes(previous) {
  const token = process.env.GITHUB_TOKEN
  const compareUrl = previous
    ? `${serverUrl}/${repo}/compare/${previous}...${tag}`
    : `${serverUrl}/${repo}/commits/${tag}`
  const fallback = `See the [commit history](${compareUrl}) for the changes in this release.`
  if (!token) {
    console.warn('::warning::GITHUB_TOKEN is not set; skipping generated release notes')
    return fallback
  }
  const body = { tag_name: tag }
  if (previous) body.previous_tag_name = previous
  try {
    const response = await fetch(`${apiUrl}/repos/${repo}/releases/generate-notes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      console.warn(
        `::warning::generate-notes returned ${response.status}: ${await response.text()}`
      )
      return fallback
    }
    const notes = await response.json()
    // The API prefixes its own "## What's Changed" heading; the section below adds one.
    return notes.body.replace(/^## What's Changed\s*/i, '').trim() || fallback
  } catch (error) {
    console.warn(`::warning::generate-notes failed: ${error.message}`)
    return fallback
  }
}

function readMeta() {
  const meta = {}
  if (!existsSync(metaDir)) return meta
  for (const file of readdirSync(metaDir)) {
    if (!file.endsWith('.json')) continue
    const info = JSON.parse(readFileSync(join(metaDir, file), 'utf8'))
    meta[info.platform] = info
  }
  return meta
}

const files = readdirSync(assetsDir).sort()
const rows = []
const missing = []
const matched = new Set()
for (const entry of CATALOG) {
  const file = files.find((name) => entry.test.test(name))
  if (!file) {
    missing.push(entry)
    continue
  }
  matched.add(file)
  rows.push({ ...entry, file, size: statSync(join(assetsDir, file)).size })
}
const extras = files.filter((name) => !matched.has(name) && name !== CHECKSUMS)

if (missing.length > 0) {
  const list = missing.map((entry) => `${entry.platform} ${entry.arch}`).join(', ')
  if (allowIncomplete) {
    console.warn(`::warning::Release is missing packages: ${list}`)
  } else {
    console.error(
      `::error::Release is missing packages: ${list}. Files present: ${files.join(', ') || 'none'}`
    )
    process.exit(1)
  }
}
if (!files.includes(CHECKSUMS)) {
  console.warn(`::warning::${CHECKSUMS} is not among the assets`)
}

const meta = readMeta()
const windowsSigned = ['windows-x64', 'windows-arm64'].every((key) => meta[key]?.signed === true)
const macSigned = meta.macos?.signed === true
const macNotarized = meta.macos?.notarized === true
const androidReleaseKey = meta.android?.signing === 'release'

const appImageX64 =
  rows.find((row) => row.key === 'linux-appimage-x64')?.file ??
  `zen-chromium-${version}-x86_64.AppImage`
const debX64 =
  rows.find((row) => row.key === 'linux-deb-x64')?.file ?? `zen-chromium_${version}_amd64.deb`
const sampleFile = rows[0]?.file ?? appImageX64

const table = [
  '| Platform | Architecture | Download | Size |',
  '| --- | --- | --- | --- |',
  ...rows.map(
    (row) => `| ${row.platform} | ${row.arch} | ${link(row.file)} | ${formatSize(row.size)} |`
  )
]
if (extras.length > 0) {
  table.push(
    ...extras.map(
      (file) => `| Other | | ${link(file)} | ${formatSize(statSync(join(assetsDir, file)).size)} |`
    )
  )
}

// `null` entries are omitted; GitHub needs the blank lines to render Markdown inside <details>.
const installing = [
  '<details>',
  '<summary><b>Windows</b></summary>',
  '',
  'Run the installer; it installs Zen for the current user and creates a desktop shortcut. Pick the `arm64` installer on a Windows-on-ARM device (Snapdragon X and similar), otherwise `x64`.',
  windowsSigned
    ? null
    : 'The installer is not code-signed yet, so SmartScreen shows "Windows protected your PC" on first run: choose **More info → Run anyway**.',
  '',
  '</details>',
  '',
  '<details>',
  '<summary><b>macOS</b></summary>',
  '',
  'Open the disk image and drag **Zen** into *Applications*. Apple Silicon Macs (M1 and later) use the `arm64` image, Intel Macs the `x64` image.',
  macNotarized
    ? null
    : macSigned
      ? 'The app is signed but not notarized by Apple, so the first launch is blocked: choose **Open Anyway** under *System Settings → Privacy & Security*, or run `xattr -dr com.apple.quarantine /Applications/Zen.app`.'
      : 'This build is not signed or notarized by Apple, so macOS blocks the first launch ("Apple could not verify…"). Choose **Open Anyway** under *System Settings → Privacy & Security*, or run `xattr -dr com.apple.quarantine /Applications/Zen.app` once.',
  '',
  '</details>',
  '',
  '<details>',
  '<summary><b>Linux</b></summary>',
  '',
  '**AppImage** (any distribution):',
  '',
  '```sh',
  `chmod +x ${appImageX64}`,
  `./${appImageX64}`,
  '```',
  '',
  'AppImages need FUSE 2 (`sudo apt install libfuse2` on Ubuntu 22.04+). **Debian / Ubuntu**:',
  '',
  '```sh',
  `sudo apt install ./${debX64}`,
  '```',
  '',
  '</details>',
  '',
  '<details>',
  '<summary><b>Android</b></summary>',
  '',
  'Download the APK on the device and open it; allow installs from your browser when Android asks. Requires Android 8.0 or newer; containers need a WebView from Chrome 111 or newer.',
  androidReleaseKey
    ? 'The APK is signed with the project release key, so it upgrades earlier releases in place.'
    : '**This APK is signed with a temporary CI key.** It installs fine, but Android will refuse to upgrade an installation from another release over it (and vice versa): uninstall the previous version first. Once the maintainers configure a release keystore, upgrades become seamless.',
  '',
  '</details>'
].filter((line) => line !== null)

const verifying = [
  `Every file is listed in [\`${CHECKSUMS}\`](${downloadBase}/${CHECKSUMS}) and has a signed [build provenance attestation](${serverUrl}/${repo}/attestations) that ties it to the commit and workflow run that produced it.`,
  '',
  '```sh',
  `sha256sum --check --ignore-missing ${CHECKSUMS}`,
  `gh attestation verify ${sampleFile} --repo ${repo}`,
  '```'
]

const previous = previousTag()
const changes = await generatedNotes(previous)

const notes = [
  `Zen on Chromium **${version}** for Windows, macOS, Linux and Android. Pick the package for your device below.`,
  '',
  '## Downloads',
  '',
  ...table,
  '',
  '## Installing',
  '',
  ...installing,
  '',
  '## Verifying a download',
  '',
  ...verifying,
  '',
  "## What's changed",
  '',
  changes,
  ''
].join('\n')

writeFileSync(notesFile, notes)
console.log(`Wrote ${notesFile} (${rows.length} packages, previous tag: ${previous ?? 'none'})`)

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Packages in ${tag}\n\n${table.join('\n')}\n`)
}
