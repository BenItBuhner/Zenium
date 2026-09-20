import { useEffect, useState } from 'react'
import type { ReadAloudVoicesResult } from '@shared/readAloud'
import { cmd } from '@renderer/lib/api'

/**
 * The host's voices (`readAloud.voices`, the core's list and its per-language default) kept
 * once for every surface that lists them – the player's voice control, Settings' voice rows –
 * as the translate registry is kept (`lib/translate.ts`): the kept answer is at hand at once
 * (a phone sheet measures itself as it mounts, a menulist shows its value as it renders) and is
 * read again whenever a surface asks, since an engine may list more voices later.
 */

const EMPTY: ReadAloudVoicesResult = { voices: [], byLanguage: {} }

let kept: ReadAloudVoicesResult | null = null
let request: Promise<ReadAloudVoicesResult> | null = null

/** The list, asked of the core once at a time; a failing host answers with no voices. */
export function loadReadAloudVoices(): Promise<ReadAloudVoicesResult> {
  if (!request) {
    request = cmd('readAloud.voices', undefined)
      .then(
        (result) => (kept = result && Array.isArray(result.voices) ? result : EMPTY),
        () => kept ?? EMPTY
      )
      .finally(() => {
        request = null
      })
  }
  return request
}

/** The kept answer, or null before the first arrives. */
export function readAloudVoicesNow(): ReadAloudVoicesResult | null {
  return kept
}

/** Have the list at hand before a surface that lists it opens; a no-op once asked. */
export function warmReadAloudVoices(): void {
  if (kept === null) void loadReadAloudVoices()
}

/**
 * The voices for a surface: the kept answer at once when there is one, else null until the
 * first arrives; read again on mount and whenever `key` changes. `enabled` false asks nothing
 * (a host without a speech engine, the phone's player until its picker is opened).
 */
export function useReadAloudVoices(enabled: boolean, key = ''): ReadAloudVoicesResult | null {
  const [voices, setVoices] = useState<ReadAloudVoicesResult | null>(kept)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void loadReadAloudVoices().then((result) => {
      if (!cancelled) setVoices(result)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, key])
  return voices
}

/** Tests: forget the kept answer. */
export function resetReadAloudVoices(): void {
  kept = null
  request = null
}
