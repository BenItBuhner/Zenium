import './assets/main.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AutofillSurface } from './components/autofill/AutofillSurface'
import { ErrorBoundary, Root } from './Root'
import { chromeSurface } from './lib/formFactor'
import './lib/lastInput'
import { startBrowserSync } from './lib/ui'
import { startEngineRelay } from './translate/engine'

startBrowserSync()

// The same document serves the window's chrome and, with `?surface=autofill`, the picker's popup
// surface the desktop host floats over the page (`ElectronWindow.setPopupSurface`).
const surface = chromeSurface()
if (surface !== 'autofill') startEngineRelay()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>{surface === 'autofill' ? <AutofillSurface /> : <Root />}</ErrorBoundary>
  </StrictMode>
)
