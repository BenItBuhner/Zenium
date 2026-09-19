import type { JSX } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import type { AutofillPicker, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { browserStore } from '@renderer/lib/ui'
import { useTheme } from '@renderer/hooks/useTheme'
import { PickerPanel } from './PickerPanel'
import { useEscape } from './controls'

/** The panel's hairline border above and below its content. */
const PANEL_BORDERS = 2

/**
 * The picker's own document: `index.html?surface=autofill`, loaded by the desktop host into a
 * `WebContentsView` it floats over the page under the focused field (`ElectronWindow.
 * setPopupSurface`). It mirrors the window's state like the chrome does and draws one thing –
 * the popover panel of `UIState.autofill.picker` – on a transparent page, inside the 8 px margin
 * the core leaves for the panel's shadow. It tells the core the height its content wants
 * (`autofill.surfaceSize`) and when it holds the keyboard (`autofill.surfaceFocus`); the core
 * sizes and places the surface, and keeps the picker open while the surface has the focus.
 */
export function AutofillSurface(): JSX.Element | null {
  const state = browserStore.use((s) => s.state)
  useEffect(() => {
    document.documentElement.dataset.chromeSurface = 'autofill'
  }, [])
  if (!state) return null
  return <Surface state={state} />
}

function Surface({ state }: { state: UIState }): JSX.Element | null {
  useTheme(state)
  const picker = state.autofill.picker
  if (!picker) return null
  return <Popover key={picker.id} picker={picker} />
}

function Popover({ picker }: { picker: AutofillPicker }): JSX.Element {
  const observer = useRef<ResizeObserver | null>(null)
  const reported = useRef(0)

  // The content box swaps between the list and the unlock step; each one is measured as it comes.
  const contentRef = useCallback(
    (el: HTMLDivElement | null) => {
      observer.current?.disconnect()
      observer.current = null
      if (!el) return
      const report = (): void => {
        const height = Math.ceil(el.getBoundingClientRect().height) + PANEL_BORDERS
        if (height <= 0 || height === reported.current) return
        reported.current = height
        run('autofill.surfaceSize', { id: picker.id, height })
      }
      report()
      if (typeof ResizeObserver !== 'undefined') {
        observer.current = new ResizeObserver(report)
        observer.current.observe(el)
      }
    },
    [picker.id]
  )
  useEffect(() => () => observer.current?.disconnect(), [])

  // The document takes the keyboard on a press in it and lets go when the page (or another
  // window) takes it back.
  useEffect(() => {
    const focused = (value: boolean) => (): void =>
      run('autofill.surfaceFocus', { id: picker.id, focused: value })
    const onFocus = focused(true)
    const onBlur = focused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    if (document.hasFocus()) onFocus()
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [picker.id])

  useEscape(() => run('autofill.pick', { id: picker.id, itemId: null }))

  return (
    <div className="zen-v2-af-surface" data-surface="page">
      <div
        role="dialog"
        aria-label={picker.manageLabel.replace(/^Manage /, 'Saved ')}
        className="zen-v2-af zen-v2-af-popover"
        style={{ width: '100%' }}
      >
        <PickerPanel picker={picker} contentRef={contentRef} />
      </div>
    </div>
  )
}
