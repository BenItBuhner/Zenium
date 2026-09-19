import '@renderer/assets/main.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Download, Smartphone, Star } from 'lucide-react'
import { ErrorBoundary, Root } from '@renderer/Root'
import { dismissBanner, pushToast, showBanner, startBrowserSync } from '@renderer/lib/ui'
import { bootAndroid } from './boot'
import { installPreviewStates } from './previewStates'

/**
 * Entry for the Android chrome WebView. Zen's browser core runs right here, next to the React
 * chrome; Kotlin only hosts the page WebViews and the platform services (see `platform.ts`).
 * The chrome renders once the core has booted (`bootAndroid` fetches the big documents the
 * boot payload named before it starts the core).
 */
void bootAndroid().then(
  ({ api, preview }) => {
    window.zen = api
    if (preview) {
      document.documentElement.dataset.preview = 'true'
      installPreviewStates()
    }
    // The instrumentation drivers (android/app/src/androidTest, through `DemoHarness.chromeJs`)
    // raise messages here while nothing in the app raises an action toast or a banner of its own
    // yet. Like `__zenStores`, it hands a script in the chrome nothing it could not reach anyway.
    Object.assign(window, {
      __zenMessages: { pushToast, showBanner, dismissBanner, icons: { Download, Smartphone, Star } }
    })

    startBrowserSync()

    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <ErrorBoundary>
          <Root />
        </ErrorBoundary>
      </StrictMode>
    )
  },
  (error: unknown) => {
    console.error('[zen] the core did not boot', error)
    throw error
  }
)
