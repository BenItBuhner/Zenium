import '@renderer/assets/main.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary, Root } from '@renderer/Root'
import { startBrowserSync } from '@renderer/lib/ui'
import { bootAndroid } from './boot'

/**
 * Entry for the Android chrome WebView. Zen's browser core runs right here, next to the React
 * chrome; Kotlin only hosts the page WebViews and the platform services (see `platform.ts`).
 */
const { api, preview } = bootAndroid()
window.zen = api
if (preview) document.documentElement.dataset.preview = 'true'

startBrowserSync()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>
)
