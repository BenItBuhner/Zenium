#!/usr/bin/env node
// Tabulates the boot probe's before / after results (android-boot-probe.sh) as Markdown:
// `node android-boot-probe-table.mjs <artifact dir>` reads results-before-<n>.json and
// results-after-<n>.json (the last run of each) and prints the table the PR body carries.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'artifacts/android-boot-probe'

function load(label) {
  for (const run of [2, 1]) {
    const file = join(dir, `results-${label}-${run}.json`)
    if (existsSync(file)) {
      try {
        return { run, data: JSON.parse(readFileSync(file, 'utf8')) }
      } catch (error) {
        console.error(`${file}: ${error.message}`)
      }
    }
  }
  return null
}

const kb = (bytes) =>
  bytes === undefined || bytes === null
    ? '–'
    : bytes >= 1_000_000
      ? `${(bytes / 1_000_000).toFixed(1)} MB`
      : bytes >= 1000
        ? `${(bytes / 1000).toFixed(1)} KB`
        : `${bytes} B`
const ms = (value) =>
  value === undefined || value === null || value < 0 ? '–' : `${Math.round(value)} ms`

/** `bytes, wall (stall)` for a replayed transfer; `–` when the path does not exist on that APK. */
function transfer(sample, { sync = false } = {}) {
  if (!sample) return 'n/a'
  if (sync) return `${kb(sample.bytes)}, ${ms(sample.ms)} on the JS thread`
  const stall =
    sample.stallMs === null || sample.stallMs === undefined
      ? ''
      : `, ${ms(sample.stallMs)} in long tasks`
  return `${kb(sample.bytes)}, ${ms(sample.wallMs)} wall${stall}`
}

function indexWrites(data) {
  const writes = (data.writesDuringBoot ?? []).filter((w) => w.name === 'blocking/index.json')
  if (writes.length === 0) return 'none'
  return writes.map((w) => `${kb(w.bytes)} at +${ms(w.afterLaunchMs)}`).join('; ')
}

function otherWrites(data) {
  const writes = (data.writesDuringBoot ?? []).filter((w) => w.name !== 'blocking/index.json')
  if (writes.length === 0) return 'none'
  return writes.map((w) => `${w.name} ${kb(w.bytes)}`).join('; ')
}

function netFetch(data) {
  const replay = data.replay ?? {}
  if (!replay.netFetch) return 'n/a'
  const reply = replay.netFetch
  const spilled = replay.netFetchSpilled
  if (!spilled)
    return `reply ${kb(reply.bytes)} JSON-quoted (${kb(reply.textBytes)} of text), ${ms(reply.wallMs)} wall, ${ms(reply.parseMs)} JSON.parse${reply.stallMs !== null && reply.stallMs !== undefined ? `, ${ms(reply.stallMs)} in long tasks` : ''}`
  return `reply ${kb(reply.bytes)} (a token), ${ms(reply.wallMs)} wall; spill fetch ${kb(spilled.bytes)}, ${ms(spilled.wallMs)} wall${spilled.stallMs !== null && spilled.stallMs !== undefined ? `, ${ms(spilled.stallMs)} in long tasks` : ''}`
}

function deferred(data) {
  const list = data.replay?.bootDeferred
  if (!list || list.length === 0) return 'none (everything inline)'
  return list.map((d) => `${d.name} ${kb(d.bytes)}`).join('; ')
}

/** The documents the payload carried inline (`boot.files`): how many, how many bytes of text. */
function inlineDocuments(data) {
  const files = data.replay?.bootFiles
  if (!files) return 'n/a'
  const names = Object.keys(files)
  const bytes = names.reduce((sum, name) => sum + files[name], 0)
  return `${names.length} document${names.length === 1 ? '' : 's'}, ${kb(bytes)}`
}

/** What the boot carried of the Safe Browsing feed documents, inline or deferred, and their bytes. */
function feedDocumentsInBoot(data) {
  const files = data.replay?.bootFiles ?? {}
  const parts = []
  let bytes = 0
  for (const [name, size] of Object.entries(files)) {
    if (!name.startsWith('safebrowsing/')) continue
    parts.push(`${name.slice('safebrowsing/'.length)} ${kb(size)} inline`)
    bytes += size
  }
  for (const d of data.replay?.bootDeferred ?? []) {
    if (!d.name.startsWith('safebrowsing/')) continue
    parts.push(`${d.name.slice('safebrowsing/'.length)} ${kb(d.bytes)} deferred`)
    bytes += d.bytes
  }
  if (parts.length === 0) return 'none: not in the payload'
  return `${kb(bytes)} in the boot (${parts.join('; ')})`
}

/**
 * The Safe Browsing feed documents the chrome fetched from the handler after the core was up
 * (`AndroidStoreIO.read`, the resource timing), as wall time since `startActivity`.
 */
function feedDocumentsAfterBoot(data) {
  const fetched = (data.documentsFetched ?? []).filter(
    (d) => d.name.startsWith('safebrowsing/') && d.startMs >= (data.boot?.chromeReadyMs ?? 0)
  )
  if (fetched.length === 0) return 'none'
  const offset = data.boot?.chromeClockOffsetMs ?? 0
  const from = Math.min(...fetched.map((d) => d.startMs))
  const to = Math.max(...fetched.map((d) => d.endMs))
  const bytes = fetched.reduce((sum, d) => sum + (d.bytes ?? 0), 0)
  const size = bytes > 0 ? `, ${kb(bytes)}` : ''
  return `${fetched.length} document${fetched.length === 1 ? '' : 's'}${size}, fetched +${ms(from + offset)} to +${ms(to + offset)} after startActivity (${fetched.map((d) => d.name.slice('safebrowsing/'.length)).join(', ')})`
}

/** A time on the chrome's clock as itself and as wall time since `startActivity`. */
function chromeMark(data, key) {
  const value = data.boot?.[key]
  if (value === undefined || value === null || value < 0) return '–'
  const offset = data.boot?.chromeClockOffsetMs
  if (offset === undefined || offset === null) return ms(value)
  return `${ms(value)} chrome clock; +${ms(value + offset)} after startActivity`
}

/**
 * The chrome's `[zen] boot:` line (`bootAndroid`, `installHostGlobal.flush`): how many host
 * messages waited while the boot fetched its deferred documents. From the run's logcat
 * (`logcat-<label>.txt`, beside the results); the line is only written when something waited.
 */
function hostMessagesWaited(label) {
  const file = join(dir, `logcat-${label}.txt`)
  if (!existsSync(file)) return 'no logcat'
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.includes('[zen] boot:'))
  if (lines.length === 0) return 'none logged'
  const last = lines[lines.length - 1]
  const match = /\[zen\] boot: (.*)$/.exec(last)
  return match ? match[1].trim() : last.trim()
}

const before = load('before')
const after = load('after')

if (!before && !after) {
  console.log('No probe results found.')
  process.exit(0)
}

const cell = (result, fn) => {
  if (!result) return 'no result'
  try {
    return fn(result.data)
  } catch (error) {
    return `error: ${error.message}`
  }
}

const rows = [
  [
    'Boot payload (`Bridge.callSync("boot")` → `Host.dispatchSync("boot")` → `Storage.readAll` / `Storage.bootDocuments`)',
    (d) => transfer(d.replay?.bootPayload, { sync: true })
  ],
  ['Documents the payload carries inline (`boot.files`)', (d) => inlineDocuments(d)],
  ['Documents the payload defers to the handler', (d) => deferred(d)],
  [
    'Safe Browsing feed documents in the boot (`Storage.bootFiles`; the core reads them in `SafeBrowsingService.start`)',
    (d) => feedDocumentsInBoot(d)
  ],
  [
    'Safe Browsing feed documents read after boot (`SafeBrowsingService.loadDocuments` → `AndroidStoreIO.read` → `/zen-docs/`)',
    (d) => feedDocumentsAfterBoot(d)
  ],
  [
    'Feed document, sync read (`AndroidStoreIO.readSync` → `Host.dispatchSync("storage.read")`, JNI string + `JSON.parse`)',
    (d) => transfer(d.replay?.feedDocSync, { sync: true })
  ],
  [
    'Feed document, file handoff (`fetchDeferredDocuments` → `ChromeWebView.handoffResponse` → `BootHandoff.document`)',
    (d) => transfer(d.replay?.feedDocFetch)
  ],
  [
    'Rule index, sync read (`RuleSetStore.load` → `JsonStore.readSync` → `AndroidStoreIO.readSync`; inline in the payload)',
    (d) => transfer(d.replay?.indexSync, { sync: true })
  ],
  [
    'Rule index written back during the boot (`RuleSetStore.writeIndex` → `JsonStore.flush` → `AndroidStoreIO.write` → `Host` `storage.write` → `Storage.write`)',
    (d) => indexWrites(d)
  ],
  ['Other documents written during the boot', (d) => otherWrites(d)],
  [
    'Kotlin request-engine builds during the boot (`Blocking.rebuild`, one at process start + one per index write)',
    (d) => `${d.kotlin?.blockingBuilds ?? '–'} (last ${ms(d.kotlin?.blockingLastBuildMs)})`
  ],
  [
    'Kotlin Safe Browsing load (`SafeBrowsing.reload`)',
    (d) =>
      `${d.kotlin?.safeBrowsingFeeds ?? '–'} feeds, ${d.kotlin?.safeBrowsingEntries ?? '–'} prefixes, ${ms(d.kotlin?.safeBrowsingLoadMs)}`
  ],
  [
    '`net.fetch` of an 11 MB hosts list (`Host.fetchText` → `ChromeWebView.resolve` `evaluateJavascript` / `BootHandoff.readBody` spill → `readSpilledBody`)',
    (d) => netFetch(d)
  ],
  [
    'Chrome ready: `window.zen` set, chrome clock since navigation start',
    (d) => ms(d.boot?.chromeReadyMs)
  ],
  ['Chrome ready: wall time since `startActivity`', (d) => ms(d.boot?.launchToReadyMs)],
  ['Chrome first paint (paint timing)', (d) => chromeMark(d, 'chromeFirstPaintMs')],
  [
    'Chrome first contentful paint (paint timing)',
    (d) => chromeMark(d, 'chromeFirstContentfulPaintMs')
  ],
  ['Chrome document `load` (`loadEventEnd`)', (d) => chromeMark(d, 'chromeLoadMs')]
]

/** Rows read off the run's files rather than a result (`logcat-<label>.txt`). */
const fileRows = [
  [
    'Host messages that waited for the core during the boot fetch (`[zen] boot:` in the chrome log)',
    (label) => hostMessagesWaited(label)
  ]
]

/** The head an APK was built from, as the driver script left it beside the results (`<label>-sha.txt`). */
function sha(label) {
  const file = join(dir, `${label}-sha.txt`)
  if (!existsSync(file)) return 'unknown'
  const value = readFileSync(file, 'utf8').trim()
  return /^[0-9a-f]{40}$/.test(value) ? value : 'unknown'
}

const header = `| Transfer (call sites) | Before: main | After: branch |\n| --- | --- | --- |`
const lines = rows.map(([label, fn]) => `| ${label} | ${cell(before, fn)} | ${cell(after, fn)} |`)
for (const [label, fn] of fileRows) lines.push(`| ${label} | ${fn('before')} | ${fn('after')} |`)
console.log('### Boot handoff: before / after on the API 34 emulator\n')
console.log(`Before = main at \`${sha('before')}\`; after = this ref at \`${sha('after')}\`.\n`)
console.log(header)
console.log(lines.join('\n'))
console.log('')
console.log(
  `Medians of three replays in the booted chrome; boot measured on run ${before?.run ?? '–'} (before) / ${after?.run ?? '–'} (after). ` +
    `Profile: ${cell(before, (d) => kb(d.profile?.['safebrowsing/phishing-database.json']))} phishing-domains document, ` +
    `${cell(before, (d) => kb(d.profile?.['blocking/index.json']))} rule index.`
)
