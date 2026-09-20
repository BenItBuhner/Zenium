import { screen, type Display } from 'electron'
import type { ScreenDisplay } from '../../../core/extensions/api/systemDisplay'
import type { DisplayScreen } from './systemDisplay'

function screenDisplay(display: Display): ScreenDisplay {
  return {
    id: display.id,
    label: display.label,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    internal: display.internal,
    touchSupport: display.touchSupport,
    accelerometerSupport: display.accelerometerSupport
  }
}

/** Electron's `screen` module as the display source of `chrome.system.display`. */
export function electronDisplayScreen(): DisplayScreen {
  return {
    displays: () => screen.getAllDisplays().map(screenDisplay),
    primary: () => screenDisplay(screen.getPrimaryDisplay()),
    observe: (listener) => {
      const on = (): void => listener()
      screen.on('display-added', on)
      screen.on('display-removed', on)
      screen.on('display-metrics-changed', on)
      return () => {
        screen.off('display-added', on)
        screen.off('display-removed', on)
        screen.off('display-metrics-changed', on)
      }
    }
  }
}
