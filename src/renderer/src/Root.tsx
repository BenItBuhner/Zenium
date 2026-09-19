import React, { type JSX } from 'react'
import { App } from './App'
import { DefaultBrowserLayer } from './components/defaultbrowser/DefaultBrowserPrompt'
import { DownloadBubbleLayer } from './components/downloads/DownloadBubble'
import { MenuSheet } from './components/menus/MenuSheet'
import { NewTabCustomizeLayer } from './components/newtab/CustomizeSheet'
import { NewTabGrowLayer } from './components/newtab/NewTabGrowLayer'
import { ExternalProtocolLayer } from './components/protocol/ExternalProtocolSheet'
import { BarEditorLayer } from './components/phone/BarEditorSheet'
import { SiteInfoLayer } from './components/siteinfo/SiteInfoSheet'
import { SheetPresence } from './lib/motion/presence'
import { browserStore, uiStore } from './lib/ui'

/** Waits for the first state snapshot from the main process before rendering the browser UI. */
export function Root(): JSX.Element {
  const loaded = browserStore.use((s) => s.state !== null)
  if (!loaded) return <div className="h-full w-full" />
  return (
    <>
      <App />
      <NewTabGrowLayer />
      <NewTabCustomizeLayer />
      <DefaultBrowserLayer />
      <SiteInfoLayer />
      <BarEditorLayer />
      <DownloadBubbleLayer />
      <MenuLayer />
      <ExternalProtocolLayer />
    </>
  )
}

/**
 * Renderer-hosted context menus (hosts without native popups) float above whichever shell is up.
 * The menu's leave outlives its request (`SheetPresence`, v2 draft §11.1): the store's `null` –
 * `menu.hide` from the core, a back delivered as one event, the sheet's own dismissal landing –
 * runs the sheet down and unmounts it once it has landed; a menu popping while one is up (keyed
 * by its id) rises above the one on its way out.
 */
function MenuLayer(): JSX.Element | null {
  const menu = uiStore.use((s) => s.menu)
  return <SheetPresence>{menu ? <MenuSheet key={menu.id} menu={menu} /> : null}</SheetPresence>
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
          <h1 className="text-lg font-semibold">The browser UI crashed</h1>
          <pre className="max-w-full overflow-auto rounded-lg bg-black/10 p-3 text-left text-xs">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="rounded-lg bg-[var(--zen-element-bg)] px-3 py-1.5"
            onClick={() => location.reload()}
          >
            Reload UI
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
