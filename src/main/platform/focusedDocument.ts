/**
 * Which of a window's own documents holds the keyboard (`WindowHost.focusedDocument`).
 *
 * `webContents.getFocusedWebContents()` is not asked: on macOS a `WebContentsView` that is in no
 * window (the new tab page preloading off the window) reports `isFocused()` true once its
 * document commits and never lets go, and the API answers with it over the window's own chrome,
 * so the core read `'other'` where the truth was `'chrome'` or `'none'` and skipped its backstop
 * `focusChrome()`. A view holds a window's keyboard only in that window: the window's documents –
 * its chrome, the views in its content view (recursively: a page view may hang in a wrapper
 * view), and the toolbox docked in a page's view – are asked in turn, the chrome's word first
 * (it lets go of the keyboard, a `blur`, when a view in its window takes it).
 */

/** What is asked of a document: whether it is still there and whether it holds the keyboard. */
export interface FocusableDocument {
  isDestroyed(): boolean
  isFocused(): boolean
  /** A page's toolbox, when one is open (docked in the page's view, or a window of its own). */
  readonly devToolsWebContents?: FocusableDocument | null | undefined
}

/** A view in a window's content view: its document, when it has one, and the views in it. */
export interface DocumentView {
  /** Electron 44 yields undefined here once the contents are destroyed. */
  readonly webContents?: FocusableDocument | undefined
  readonly children: readonly DocumentView[]
}

/** A window as the decision sees it. */
export interface DocumentWindow {
  /** Whether the window has the system's focus (`BrowserWindow.isFocused`). */
  readonly focused: boolean
  /** The window's own chrome document. */
  readonly chrome: FocusableDocument
  /** The window's content view: its children are the views the window shows. */
  readonly contentView: DocumentView
}

function holdsKeyboard(document: FocusableDocument | null | undefined): boolean {
  return (
    document !== null && document !== undefined && !document.isDestroyed() && document.isFocused()
  )
}

/** Whether a document in `view` or in a view nested in it holds the keyboard. */
export function viewHoldsKeyboard(view: DocumentView): boolean {
  for (const child of view.children) {
    const wc = child.webContents
    if (holdsKeyboard(wc)) return true
    // A docked toolbox is a document of the window too: it sits in the page's own view.
    if (wc && !wc.isDestroyed() && holdsKeyboard(wc.devToolsWebContents)) return true
    if (viewHoldsKeyboard(child)) return true
  }
  return false
}

/**
 * `'chrome'` when the window's chrome holds the keyboard, `'other'` when a view in its content
 * view does – or when the keyboard is in another window altogether (this one has not got the
 * system's focus: another Zenium window, an undocked toolbox, another app), so the core leaves
 * it there rather than pull the window to the front over it – and `'none'` when the window is
 * the focused one and none of its documents has the keyboard.
 */
export function focusedDocumentOf(window: DocumentWindow): 'chrome' | 'other' | 'none' {
  if (holdsKeyboard(window.chrome)) return 'chrome'
  if (viewHoldsKeyboard(window.contentView)) return 'other'
  return window.focused ? 'none' : 'other'
}
