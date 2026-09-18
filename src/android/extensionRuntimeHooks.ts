import type { ExtensionRecord } from '@core/extensions/registry'

/**
 * The seam between the extension store (`extensionHost.ts`: downloads, files, the registry,
 * updates) and the emulation layer that runs extensions on Android (`extensions*.ts` and the
 * Kotlin `ext/Extensions.kt`, owned by the runtime). The store keeps the registry and calls these
 * after every change it persisted; the runtime reads what it needs from the record, above all
 * `record.path`, the versioned directory (`files/zen/extensions/<id>/<version>/`) whose
 * `manifest.json` it loads. Every call may reject; the store records the message as the
 * extension's load error and carries on.
 */
export interface ExtensionRuntimeHooks {
  /**
   * Start running an extension: after an install, at startup for every enabled record, and when
   * the user enables one. Called again with the new record after an update landed (the old
   * version was detached first).
   */
  attach(record: ExtensionRecord): Promise<void>
  /** Stop running an extension: it was disabled, removed, or is about to be replaced by an update. */
  detach(id: string): Promise<void>
  /**
   * A record changed while the extension stays attached: `pinned`, `allowFileAccess`,
   * `allowPrivate` or the manifest-derived fields after a reload. The runtime re-reads what it configures from them.
   */
  reconfigure(record: ExtensionRecord): Promise<void>
}

/** Before the runtime lands (or on hosts that only manage packages): installs are files and records. */
export const noRuntimeHooks: ExtensionRuntimeHooks = {
  attach: async () => undefined,
  detach: async () => undefined,
  reconfigure: async () => undefined
}
