import type { NewTabBackgroundHost, StoreIO } from '@core/platform'
import { JsonStore } from '@core/store/JsonStore'

interface Persisted {
  version: 1
  /** The picked wallpaper as a data URL; null once the user let it go. */
  dataUrl: string | null
}

/** A picked wallpaper larger than this is refused rather than persisted. */
const MAX_WALLPAPER_BYTES = 6 * 1024 * 1024

/**
 * The phone's new tab background image. The chrome reads the picked file itself (the Android
 * file chooser hands the page a data URL, scaled for a phone screen) and hands it here through
 * `set`; the image lives in its own document, `newtab-wallpaper.json` – the file the phone's
 * first new tab page (#51) wrote, read as it is – so it is never part of a state broadcast, and
 * the page fetches it once (`newtab.backgroundImage`). There is no file dialog to `pick` with.
 */
export class AndroidNewTabBackground implements NewTabBackgroundHost {
  private readonly store: JsonStore<Persisted>
  private image: string | null

  constructor(io: StoreIO) {
    this.store = new JsonStore<Persisted>(io, 'newtab-wallpaper.json', 300)
    const data = this.store.readSync()
    this.image =
      data?.version === 1 &&
      typeof data.dataUrl === 'string' &&
      data.dataUrl.startsWith('data:image/')
        ? data.dataUrl
        : null
  }

  current(): string | null {
    return this.image
  }

  async set(dataUrl: string | null): Promise<void> {
    if (dataUrl !== null) {
      if (!dataUrl.startsWith('data:image/')) throw new Error('The wallpaper must be an image')
      if (dataUrl.length > MAX_WALLPAPER_BYTES) throw new Error('The wallpaper image is too large')
    }
    this.image = dataUrl
    this.store.write({ version: 1, dataUrl })
    // Landed before the caller hears back: a pause right after the pick loses nothing.
    await this.store.flush()
  }

  async clear(): Promise<void> {
    await this.set(null)
  }
}
