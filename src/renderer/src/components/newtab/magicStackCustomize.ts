import { createStore } from '@renderer/lib/store'

/**
 * Whether the Magic Stack's Customise sheet is up. The sheet itself is mounted once at the root
 * (`MagicStackCustomizeLayer`), as the page's own customise sheet is; the card menus open it
 * from here so the component file exports components alone.
 */
export const magicStackCustomizeStore = createStore<{ open: boolean }>(
  { open: false },
  'newtab-magic-stack-customize'
)

export function openMagicStackCustomize(): void {
  magicStackCustomizeStore.set({ open: true })
}

export function closeMagicStackCustomize(): void {
  magicStackCustomizeStore.set({ open: false })
}
