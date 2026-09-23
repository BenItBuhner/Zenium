import type { ExtensionPromptRequest } from '@shared/types'
import { noWarningsLine, promptCopy } from '@renderer/lib/extensions/promptCopy'
import { warningGlyph } from '@renderer/lib/extensions/warningGlyph'
import type { NativePromptPlan, NativePromptRow } from './extensionStoreIo'

export type { NativePromptPlan, NativePromptRow } from './extensionStoreIo'

/**
 * The install, update and `permissions.request` prompt as the Kotlin side draws it when no live
 * window can show the renderer's sheet (`ext/ExtensionPromptFallback.kt` on the native chassis,
 * `NativePromptSheet`): the v2 §9.23 composition, composed here so the words and the rows are the
 * renderer's (`ExtensionPromptDialog`) on both paths and Kotlin decides nothing. The plan's shape
 * is `NativePromptPlan` (extensionStoreIo.ts, the bridge contract). The plan for a request is the
 * same words the renderer's dialog would show for it.
 */
export function nativePromptPlan(
  prompt: Omit<ExtensionPromptRequest, 'requestId'>
): NativePromptPlan {
  const copy = promptCopy(prompt)
  const rows: NativePromptRow[] =
    prompt.warnings.length === 0
      ? [{ glyph: null, label: noWarningsLine(prompt.kind), deemphasized: true }]
      : prompt.warnings.map((warning) => ({
          glyph: warningGlyph(warning),
          label: warning,
          deemphasized: false
        }))
  return {
    title: copy.title,
    description: copy.subtitle,
    icon: prompt.icon,
    caption: prompt.warnings.length > 0 ? 'It can:' : null,
    rows,
    secondary: 'Cancel',
    primary: { label: copy.accept, tone: 'accent' }
  }
}
