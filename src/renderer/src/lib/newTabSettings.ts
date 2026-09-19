import type { NewTabBackgroundKind, NewTabPreset, NewTabSettings } from '@shared/types'
import { newTabBackground } from '@shared/newTab'

/**
 * The words of the desktop's Settings › New tab rows over the one model (`shared/newTab.ts`):
 * the layout names the phone's customise sheet uses, one per preset, so a layout picked on a
 * phone reads the same here.
 */
export const NEW_TAB_PRESET_LABELS: Record<NewTabPreset, string> = {
  focused: 'Focused',
  inspirational: 'Inspirational',
  informational: 'Informational',
  custom: 'Custom'
}

/** What each layout shows, for the phone-form picker sheet's option lines. */
export const NEW_TAB_PRESET_DESCRIPTIONS: Record<NewTabPreset, string> = {
  focused: 'The search field and the tiles on the space gradient',
  inspirational: 'A wallpaper and a greeting as well',
  informational: 'Not available: Zenium has no feed',
  custom: 'Exactly the sections the rows below say'
}

export const NEW_TAB_LAYOUT_HINT =
  'Inspirational adds a wallpaper and a greeting. Changing a row below makes the layout Custom.'

/**
 * The Background row's value: what the page paints – the source while the wallpaper section is
 * on, the space gradient otherwise – and an image this device does not have reads as the space
 * gradient too, which is what the page shows for it.
 */
export function newTabBackgroundValue(
  settings: NewTabSettings,
  image: boolean
): NewTabBackgroundKind {
  const background = newTabBackground(settings)
  return background === 'image' && !image ? 'space' : background
}
