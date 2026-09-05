import React, { type JSX } from 'react'
import { App } from './App'
import { browserStore } from './lib/ui'

/** Waits for the first state snapshot from the main process before rendering the browser UI. */
export function Root(): JSX.Element {
  const loaded = browserStore.use((s) => s.state !== null)
  if (!loaded) return <div className="h-full w-full" />
  return <App />
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
