import { describe, expect, it } from 'vitest'
import {
  focusedDocumentOf,
  viewHoldsKeyboard,
  type DocumentView,
  type DocumentWindow,
  type FocusableDocument
} from '../focusedDocument'

/** A document as the decision asks it, with a toolbox when the test gives it one. */
function document(
  focused: boolean,
  options: { destroyed?: boolean; devtools?: FocusableDocument | null } = {}
): FocusableDocument {
  return {
    isDestroyed: () => options.destroyed ?? false,
    isFocused: () => focused,
    devToolsWebContents: options.devtools ?? null
  }
}

/** A view with a document (a `WebContentsView`), or a plain view without one (a wrapper). */
function view(webContents?: FocusableDocument, children: DocumentView[] = []): DocumentView {
  return webContents ? { webContents, children } : { children }
}

/** The window's content view holding `children`. */
function contentView(...children: DocumentView[]): DocumentView {
  return { children }
}

function windowWith(
  chrome: FocusableDocument,
  content: DocumentView,
  focused = true
): DocumentWindow {
  return { focused, chrome, contentView: content }
}

describe('focusedDocumentOf', () => {
  it('names the chrome when the window’s own chrome holds the keyboard, whatever a view in no window claims (the macOS preload)', () => {
    // PR #347's macOS reading: the chrome focused and the URL bar's field active; the one view in
    // the window hidden and not focused; a fresh preload in no window saying it is focused – and
    // `getFocusedWebContents()` answering with that one. It is in no window: never asked.
    const adopted = view(document(false))
    expect(focusedDocumentOf(windowWith(document(true), contentView(adopted)))).toBe('chrome')
  })

  it('names another document when a view in the window’s content view holds it: a page, an extension popup, the picker', () => {
    const page = view(document(true))
    expect(focusedDocumentOf(windowWith(document(false), contentView(page)))).toBe('other')
    const popup = view(document(true))
    expect(
      focusedDocumentOf(windowWith(document(false), contentView(view(document(false)), popup)))
    ).toBe('other')
  })

  it('sees a page view through the wrapper it hangs in, however deep', () => {
    const page = view(document(true))
    const wrapper = view(undefined, [page])
    expect(focusedDocumentOf(windowWith(document(false), contentView(wrapper)))).toBe('other')
    const nested = view(undefined, [view(undefined, [view(document(false)), wrapper])])
    expect(focusedDocumentOf(windowWith(document(false), contentView(nested)))).toBe('other')
    expect(viewHoldsKeyboard(nested)).toBe(true)
    expect(viewHoldsKeyboard(view(undefined, [view(undefined, [view(document(false))])]))).toBe(
      false
    )
  })

  it('counts the toolbox docked in a page’s view as a document of the window', () => {
    const page = view(document(false, { devtools: document(true) }))
    expect(focusedDocumentOf(windowWith(document(false), contentView(page)))).toBe('other')
    // A toolbox that is up but not typing in: nothing of the window's holds it.
    const idle = view(document(false, { devtools: document(false) }))
    expect(focusedDocumentOf(windowWith(document(false), contentView(idle)))).toBe('none')
  })

  it('says none when the window is the focused one and no document of its own has the keyboard', () => {
    const hidden = view(document(false))
    expect(focusedDocumentOf(windowWith(document(false), contentView(hidden)))).toBe('none')
    expect(focusedDocumentOf(windowWith(document(false), contentView()))).toBe('none')
  })

  it('reads the keyboard as elsewhere while the window has not got the system’s focus – another window, an undocked toolbox, another app', () => {
    // The core's backstop `focusChrome()` would pull this window over the one the user is in.
    expect(
      focusedDocumentOf(windowWith(document(false), contentView(view(document(false))), false))
    ).toBe('other')
    expect(focusedDocumentOf(windowWith(document(false), contentView(), false))).toBe('other')
    // Its own documents still come first: a chrome that says it holds the keyboard is believed
    // (macOS keeps the first responder of a window that is not key).
    expect(focusedDocumentOf(windowWith(document(true), contentView(), false))).toBe('chrome')
    expect(
      focusedDocumentOf(windowWith(document(false), contentView(view(document(true))), false))
    ).toBe('other')
  })

  it('asks nothing of a destroyed document, a view whose contents are gone, or a toolbox that closed', () => {
    const gone = view(document(true, { destroyed: true }))
    const noContents = view(undefined)
    const closedToolbox = view(document(false, { devtools: document(true, { destroyed: true }) }))
    expect(
      focusedDocumentOf(windowWith(document(false), contentView(gone, noContents, closedToolbox)))
    ).toBe('none')
    // A chrome that is gone never names itself.
    expect(
      focusedDocumentOf(
        windowWith(document(true, { destroyed: true }), contentView(view(document(true))))
      )
    ).toBe('other')
  })

  it('takes the chrome’s word over a view’s when both claim the keyboard', () => {
    expect(focusedDocumentOf(windowWith(document(true), contentView(view(document(true)))))).toBe(
      'chrome'
    )
  })
})
