import { app } from 'electron'
import { join } from 'node:path'
import type { ResourceSettings } from '../../../shared/types'
import { JsonStore } from '../../../core/store/JsonStore'
import {
  deriveStartupProfile,
  sanitizeResourceSettings,
  type StartupProfile
} from '../../../core/resources/switches'
import { FileStoreIO } from '../storeIo'

let applied: StartupProfile | null = null

/**
 * Read the persisted resource settings and put the derived Chromium / V8 switches on the command
 * line. Must run before `app.whenReady()` resolves – Chromium reads them while starting up.
 */
export function applyResourceSwitches(userDataDir: string): StartupProfile {
  const settings = readPersistedResourceSettings(userDataDir)
  const profile = deriveStartupProfile(settings)
  for (const sw of profile.switches) {
    if (sw.value === undefined) app.commandLine.appendSwitch(sw.name)
    else app.commandLine.appendSwitch(sw.name, sw.value)
  }
  if (!profile.hardwareAcceleration) app.disableHardwareAcceleration()
  applied = profile
  return profile
}

/** The profile this process was started with (null when `applyResourceSwitches` never ran). */
export function appliedStartupProfile(): StartupProfile | null {
  return applied
}

function readPersistedResourceSettings(userDataDir: string): ResourceSettings {
  const store = new JsonStore<{ settings?: { resources?: unknown } }>(
    new FileStoreIO(join(userDataDir, 'zen')),
    'state.json'
  )
  const data = store.readSync()
  return sanitizeResourceSettings(data?.settings?.resources)
}
