import { DEVTOOLS_KEY_MESSAGE_PREFIX, type DevtoolsFrontendLike } from '../devtoolsKeys'

/**
 * A frontend as the relay and the held-key notice see it: its console listeners, the scripts
 * run in it, its main frame – the frame a line is said from is the main frame unless the test
 * names another – and whether it is gone.
 */
export function fakeFrontend(): DevtoolsFrontendLike & {
  listeners: ((event: { message: string; frame?: unknown }) => void)[]
  scripts: string[]
  say(message: string, frame?: unknown): void
  sayFrameless(message: string): void
  destroy(): void
} {
  const listeners: ((event: { message: string; frame?: unknown }) => void)[] = []
  const scripts: string[] = []
  const mainFrame = { name: 'devtools://devtools/bundled/devtools_app.html' }
  let destroyed = false
  return {
    listeners,
    scripts,
    mainFrame,
    on: (_event, listener) => listeners.push(listener),
    executeJavaScript: (code) => {
      scripts.push(code)
      return Promise.resolve('hooked')
    },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    },
    say: (message, frame = mainFrame) =>
      listeners.forEach((listener) => listener({ message, frame })),
    sayFrameless: (message) => listeners.forEach((listener) => listener({ message }))
  }
}

/** The macOS quit chord's key down as the frontend script says it. */
export const KEY_DOWN_LINE = `${DEVTOOLS_KEY_MESSAGE_PREFIX}{"type":"keyDown","key":"q","control":false,"alt":false,"shift":false,"meta":true,"isAutoRepeat":false}`
/** The key up after it – ⌘'s release, the hold's own rule: whichever key. */
export const KEY_UP_LINE = `${DEVTOOLS_KEY_MESSAGE_PREFIX}{"type":"keyUp","key":"Meta","control":false,"alt":false,"shift":false,"meta":false,"isAutoRepeat":false}`
