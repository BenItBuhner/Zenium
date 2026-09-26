// The profile's `state.json` as the smoke reads it, with the store's own fallback to the
// document's backup. Pure over an injected reader (the tests hand one in); smoke.mjs's
// `readState` is `readProfileState` over the profile's `zen/` directory. Unit-tested by
// profile-state.test.mjs.
//
// The desktop store (src/main/platform/storeIo.ts, `FileStoreIO.write` / `writeSync`) lands a
// document the core opened with `backup: true` – `state.json` is one – in TWO renames: the
// document that was there goes to `state.json.bak`, then the temp file holding the new version
// goes to `state.json`. A process ended between the two (the crash scenario's SIGKILL) leaves NO
// `state.json` at all, while `state.json.bak` holds the version that was the document a moment
// before, and nothing completes the second rename: the profile stays that way until the next
// launch. The core's `JsonStore.readSync` (src/core/store/JsonStore.ts) reads the backup in the
// document's place then – as it does for a document that is there but empty or not JSON. The
// smoke read `state.json` alone and reported ENOENT where the app restored from the backup
// (#535's merge-up, run 36242423806: the crash scenario's `kill` and the crash-restore's
// `restore-offer` failed while the restore bar stood). `readProfileState` follows the store's
// rule and says which file answered, so a scenario can tell a state read from the backup – the
// write BEFORE the last one – from the document itself, and judge whether that is the version it
// needs.

import fs from 'node:fs'
import path from 'node:path'

/** The document, under the profile's `zen/` directory. */
export const STATE_FILE = 'state.json'
/** Its backup: the version the last write replaced (the store's `backup` option). */
export const STATE_BACKUP_FILE = 'state.json.bak'

/** The default reader: the file's text, or `null` when there is no such file. */
function readUtf8(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw e
  }
}

/**
 * One document under the store's rule (`JsonStore.parse`): `{ ok: true, doc }` for a JSON
 * document, else `{ ok: false, reason }` – `missing` (no file), `empty` (nothing in it) or
 * `corrupt (...)` with the parser's message; `unreadable (...)` when the read itself failed.
 * The core's `parse` answers null for each of the failures, and for the JSON `null` too.
 */
export function parseStateDocument(file, read = readUtf8) {
  let raw
  try {
    raw = read(file)
  } catch (e) {
    return { ok: false, reason: `unreadable (${e && e.message ? e.message : String(e)})` }
  }
  if (raw === null || raw === undefined) return { ok: false, reason: 'missing' }
  if (raw === '') return { ok: false, reason: 'empty' }
  try {
    const doc = JSON.parse(raw)
    if (doc === null) return { ok: false, reason: 'corrupt (the document is null)' }
    return { ok: true, doc }
  } catch (e) {
    return { ok: false, reason: `corrupt (${e && e.message ? e.message : String(e)})` }
  }
}

/** The fields the scenarios assert on, from a parsed document. */
function summary(s) {
  return {
    version: s.version,
    windows: (s.windows || []).length,
    tabs: (s.tabs || []).map((t) => ({ url: t.url, title: t.title })),
    onboardingDone: s.settings && s.settings.onboardingDone,
    cleanExit: s.cleanExit
  }
}

/**
 * The profile's state as the smoke reads it, from the documents under `dir` (the profile's
 * `zen/`): the fields the scenarios assert on – `version`, `windows` (a count), `tabs` (url and
 * title each), `onboardingDone`, and `cleanExit`, #129's marker (false from the first write of a
 * run, true from the write a graceful quit ends with, absent from a profile no run has written
 * yet) – plus which file answered:
 *
 *   file      `state.json`, or `state.json.bak` when the document itself could not be read and
 *             the backup could – the store's own rule
 *   primary   with the backup answering: why the document could not be read – `missing` (no
 *             file: a process ended between the store's two renames), `empty`, `corrupt (...)`
 *             or `unreadable (...)`
 *
 * Neither readable: `{ error }` naming both files and what was wrong with each. Never a throw
 * (a caller polls this while the app writes, and asserts on the fields).
 */
export function readProfileState(dir, read = readUtf8) {
  const primaryPath = path.join(dir, STATE_FILE)
  const backupPath = path.join(dir, STATE_BACKUP_FILE)
  const primary = parseStateDocument(primaryPath, read)
  if (primary.ok) return { file: STATE_FILE, ...summary(primary.doc) }
  const backup = parseStateDocument(backupPath, read)
  if (backup.ok) {
    return { file: STATE_BACKUP_FILE, primary: primary.reason, ...summary(backup.doc) }
  }
  return {
    error: `neither ${STATE_FILE} nor ${STATE_BACKUP_FILE} is readable: ${primaryPath} ${primary.reason}; ${backupPath} ${backup.reason}`
  }
}

/**
 * Which file answered, for a step's log line: `state.json`; `state.json.bak (state.json
 * missing)` and the like for the backup; `neither (...)` for a read that got nothing.
 */
export function stateSource(state) {
  if (!state || state.error) return `neither (${state ? state.error : 'no state read'})`
  if (state.file === STATE_BACKUP_FILE)
    return `${STATE_BACKUP_FILE} (${STATE_FILE} ${state.primary})`
  return state.file
}

/**
 * Whether `state` is the backup standing in for a document a kill took mid-write: the backup
 * answered because `state.json` is MISSING – the store's window between its two renames, the
 * one shape a SIGKILL can leave. A backup answering for a `state.json` that IS there but empty
 * or unparsable is not that: the store's temp file and rename never leave such a document, so
 * the crash steps fail on it rather than read past it.
 */
export function fromRenameWindow(state) {
  return Boolean(state) && state.file === STATE_BACKUP_FILE && state.primary === 'missing'
}

/**
 * The state a killed run left, as the next launch's reader takes it: `state.json` when the kill
 * missed the store's rename window, else the backup standing in for it (`fromRenameWindow`).
 * Throws, naming both files, for a backup answering on any other account and for no state at
 * all. The fields are the caller's to assert on: a backup from the window is a write of the
 * killed run – the crash scenario kills only after it has seen the run's marker in `state.json`,
 * so the version the next write moved into the backup carries it too.
 */
export function stateAfterKill(state, when = 'after the kill') {
  if (!state || state.error) {
    throw new Error(`no readable state ${when}: ${state ? state.error : 'no state read'}`)
  }
  if (state.file === STATE_BACKUP_FILE && !fromRenameWindow(state)) {
    throw new Error(
      `${STATE_FILE} ${state.primary} ${when} (the store's rename leaves a whole document or none); ${STATE_BACKUP_FILE} holds cleanExit ${JSON.stringify(state.cleanExit)} with ${state.tabs.length} tab(s)`
    )
  }
  return state
}

/**
 * The state a graceful quit left, which is `state.json` itself: the quit's final write lands
 * both renames before the process exits (Session.quitGracefully's contract: callers read the
 * profile after the exit event), so the backup – the write before the last – is never the
 * answer, and with the process gone nothing writes the document later, so there is nothing to
 * wait for. Throws, naming both files and what the backup holds, when `state.json` did not
 * answer: the log then tells a final write that never landed from a profile with nothing in it.
 */
export function requireStateFile(state, when = 'after the quit') {
  if (!state || state.error) {
    throw new Error(`no readable state ${when}: ${state ? state.error : 'no state read'}`)
  }
  if (state.file !== STATE_FILE) {
    throw new Error(
      `${STATE_FILE} ${state.primary} ${when}; ${STATE_BACKUP_FILE} holds the write before the last (cleanExit ${JSON.stringify(state.cleanExit)}, ${state.tabs.length} tab(s)): the run's last write never landed`
    )
  }
  return state
}
