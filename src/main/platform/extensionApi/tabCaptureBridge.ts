import { webContents as electronWebContents } from 'electron'
import type { StreamRegistrar } from './tabCapture'

/**
 * The engine's stream registry as Electron exposes it: `webContents.getMediaSourceId(consumer)`
 * registers a stream of the target's page that the consumer's main frame may redeem with
 * `getUserMedia` (`chromeMediaSource: "tab"`) within Chromium's ten seconds, once.
 */
export function electronStreamRegistrar(): StreamRegistrar {
  return {
    register: (target, consumer) => target.getMediaSourceId(consumer),
    alive: (webContentsId) => {
      const wc = electronWebContents.fromId(webContentsId)
      return wc !== undefined && !wc.isDestroyed()
    }
  }
}
