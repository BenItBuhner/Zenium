import type { NewTabPhoneSettings } from '../shared/types'
import { pinSite, removeSite, sanitizeNewTabPhoneSettings, unpinSite } from '../shared/newTabPhone'
import { JsonStore } from './store/JsonStore'
import type { Browser } from './browser'

interface Persisted {
  version: 1
  /** The picked wallpaper as a data URL; null once the user let it go. */
  dataUrl: string | null
}

/** A picked wallpaper larger than this is refused rather than persisted. */
const MAX_WALLPAPER_BYTES = 6 * 1024 * 1024

/**
 * The new tab page's settings mutators and its wallpaper. The settings themselves ride in
 * `Settings.newTab` (small: a preset, a few flags, pinned sites, removed hosts); the picked
 * wallpaper image is kept in its own document so it is never part of a state broadcast.
 */
export class NewTabPhoneService {
  private readonly store: JsonStore<Persisted>
  private wallpaper: string | null

  constructor(private readonly browser: Browser) {
    this.store = new JsonStore<Persisted>(browser.platform.io, 'newtab-wallpaper.json', 300)
    const data = this.store.readSync()
    this.wallpaper =
      data?.version === 1 &&
      typeof data.dataUrl === 'string' &&
      data.dataUrl.startsWith('data:image/')
        ? data.dataUrl
        : null
  }

  wallpaperImage(): string | null {
    return this.wallpaper
  }

  setWallpaperImage(dataUrl: string | null): void {
    if (dataUrl !== null) {
      if (!dataUrl.startsWith('data:image/')) throw new Error('The wallpaper must be an image')
      if (dataUrl.length > MAX_WALLPAPER_BYTES) throw new Error('The wallpaper image is too large')
    }
    this.wallpaper = dataUrl
    this.store.write({ version: 1, dataUrl })
    // Picking an image is meant to be seen: the wallpaper source follows the pick.
    this.update((s) => ({ ...s, wallpaper: dataUrl ? 'image' : 'space' }))
  }

  pin(url: string, title: string): void {
    this.update((s) => pinSite(s, { url, title }))
  }

  unpin(url: string): void {
    this.update((s) => unpinSite(s, url))
  }

  remove(url: string): void {
    this.update((s) => removeSite(s, url))
  }

  private update(mutate: (settings: NewTabPhoneSettings) => NewTabPhoneSettings): void {
    const { state } = this.browser
    state.settings.newTabPhone = sanitizeNewTabPhoneSettings(mutate(state.settings.newTabPhone))
    state.commit()
  }

  flushSync(): void {
    this.store.flushSync()
  }
}
