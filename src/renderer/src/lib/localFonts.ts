import { useEffect, useState } from 'react'

/**
 * The families installed on this computer, for Settings › Appearance › Customise fonts' family
 * pickers (CT-25; Chrome's fonts page lists the same). Read through the chrome document's Local
 * Font Access API (`queryLocalFonts`, which the desktop host grants to the chrome alone – the
 * `local-fonts` permission in `src/main/platform/index.ts`) and kept once, as the read-aloud
 * voices are (`readAloudVoices.ts`): a menulist shows its options as it renders, so the list is
 * at hand from the second visit, and a host without the API (Android's WebView, a test) answers
 * with none – its rows keep to the generic families.
 */

interface LocalFontData {
  family: string
  fullName: string
  postscriptName: string
  style: string
}

type FontsWindow = Window & { queryLocalFonts?: () => Promise<LocalFontData[]> }

let kept: string[] | null = null
let request: Promise<string[]> | null = null

/** Distinct family names, sorted as the picker lists them; a hidden family (macOS's `.` names) left out. */
export function familiesOf(fonts: readonly Pick<LocalFontData, 'family'>[]): string[] {
  const seen = new Set<string>()
  for (const font of fonts) {
    const family = font.family.trim()
    if (!family || family.startsWith('.')) continue
    seen.add(family)
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

/** Whether this document can list the computer's fonts at all. */
export function localFontsAvailable(): boolean {
  return typeof (window as FontsWindow).queryLocalFonts === 'function'
}

/** The families, asked of the document once at a time; a refusal (the permission, an error) is an empty list. */
export function loadLocalFonts(): Promise<string[]> {
  if (!request) {
    const query = (window as FontsWindow).queryLocalFonts
    request = (query ? query.call(window) : Promise.resolve([]))
      .then(
        (fonts) => (kept = familiesOf(fonts)),
        () => (kept = kept ?? [])
      )
      .finally(() => {
        request = null
      })
  }
  return request
}

/** The kept list, or null before the first answer. */
export function localFontsNow(): string[] | null {
  return kept
}

/**
 * The families for a surface: the kept list at once when there is one, else null until the
 * first answer; `enabled` false asks nothing (a host whose family rows are the generic names, a
 * section that has no font row on screen).
 */
export function useLocalFonts(enabled: boolean): string[] | null {
  const [fonts, setFonts] = useState<string[] | null>(kept)
  useEffect(() => {
    if (!enabled || kept !== null) return
    let cancelled = false
    void loadLocalFonts().then((result) => {
      if (!cancelled) setFonts(result)
    })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return fonts
}

/** Tests: forget the kept list. */
export function resetLocalFonts(): void {
  kept = null
  request = null
}
