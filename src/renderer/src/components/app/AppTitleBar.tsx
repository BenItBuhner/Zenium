import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { AppWindowInfo, Tab, UIState } from '@shared/types'
import { displayHost } from '@shared/url'
import { formatWindowTitle } from '@shared/windowTitle'
import { APP_MENU_EVENT, hint, openAppMenu } from '@renderer/lib/shortcuts'
import { Favicon } from '../sidebar/Favicon'
import { TOOLBAR_STROKE } from '../v2/controls'
import { WindowControls } from '../WindowControls'

/**
 * The title bar of a web app's standalone window (MW-23; Chrome's app window at `display-mode:
 * standalone`): the one row of chrome the window has, in place of the browser's toolbar. The
 * app's icon (the installed record's, else the page's favicon) and the window's title – the
 * page's title, the app's name while the page has none, as the native title reads – lead; the
 * "⋯" menu (the core's web-app menu: Copy URL, Open in Zenium, Zoom, Find, Print, Uninstall)
 * and the window's own buttons trail, where the host does not draw them itself. No address, no
 * navigation buttons: the app keeps to its scope (a navigation out of it opens in the browser),
 * and Back and Reload keep their shortcuts. The whole row drags the window; the tooltip on the
 * title says where the page is, for the origin Chrome flashes on the bar when the window opens.
 */
export function AppTitleBar({
  state,
  tab,
  app,
  trailingInset = 0,
  leadingInset = 0
}: {
  state: UIState
  tab: Tab | null
  app: AppWindowInfo
  /** Room (px) kept clear at the trailing end for native caption buttons drawn over the row. */
  trailingInset?: number
  /** Room (px) kept clear at the leading end for macOS traffic lights. */
  leadingInset?: number
}): JSX.Element {
  const title = formatWindowTitle(tab?.title, false, app.name)
  const host = tab ? displayHost(tab.url) : ''
  const menuButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // Alt+F / F10: the menu opens from this button with the keyboard on it, so Escape closes the
    // menu and leaves the focus here (§9.22) – the same claim the browser toolbar's button makes.
    const fromKeyboard = (e: Event): void => {
      const button = menuButton.current
      if (!button || e.defaultPrevented || button.offsetParent === null) return
      e.preventDefault()
      button.focus()
      openAppMenu(button, true)
    }
    window.addEventListener(APP_MENU_EVENT, fromKeyboard)
    return () => window.removeEventListener(APP_MENU_EVENT, fromKeyboard)
  }, [])
  return (
    // A window surface (design language v2 §9.29), as the toolbar row is; the bar the in-chrome
    // app menu hangs from (§9.20: flush under it, end-aligned with its "⋯"). A `header`: the
    // app window's banner landmark (a11y-02), as the browser window's toolbar is.
    <header
      className="zen-app-titlebar zen-drag"
      data-surface="window"
      data-bar=""
      data-zen-app-titlebar
      data-testid="app-titlebar"
      style={{
        ...(trailingInset > 0 ? { paddingRight: trailingInset + 4 } : {}),
        ...(leadingInset > 0 ? { paddingLeft: leadingInset } : {})
      }}
    >
      <AppIcon app={app} tab={tab} />
      <span className="zen-app-titlebar-title truncate" title={host || undefined}>
        {title}
      </span>
      <button
        ref={menuButton}
        type="button"
        // The "⋯" the renderer-drawn menu finds and hangs from (`APP_MENU_BUTTON`), as the
        // browser toolbar's; the menu marks it `aria-expanded` while it stands.
        data-zen-app-menu-button
        className="zen-toolbar-button zen-no-drag"
        title={hint('Menu', state, 'menu.app')}
        aria-haspopup="menu"
        onClick={() => openAppMenu(menuButton.current)}
      >
        <MoreHorizontal className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
      </button>
      <WindowControls />
    </header>
  )
}

/** The installed app's icon; the page's favicon (with its fallbacks) for a window no app owns. */
function AppIcon({ app, tab }: { app: AppWindowInfo; tab: Tab | null }): JSX.Element | null {
  const [broken, setBroken] = useState<string | null>(null)
  const icon = app.icon && broken !== app.icon ? app.icon : null
  if (icon) {
    return (
      <img
        className="zen-app-titlebar-icon"
        src={icon}
        alt=""
        draggable={false}
        onError={() => setBroken(icon)}
      />
    )
  }
  if (!tab) return null
  return <Favicon tab={tab} size={16} className="zen-app-titlebar-icon" />
}
