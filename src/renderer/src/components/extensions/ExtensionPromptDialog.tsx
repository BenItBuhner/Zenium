import type { JSX } from 'react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ExtensionPromptRequest } from '@shared/types'
import { useEscape } from '@renderer/hooks/useEscape'
import { usePopover } from '@renderer/hooks/usePopover'
import { answerExtensionPrompt } from '@renderer/lib/extensions/popup'
import { fromSource } from '@renderer/lib/extensions/storeInput'
import { useViewport } from '@renderer/lib/formFactor'
import { useFrameDialog } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { ExtensionIcon } from './ExtensionIcon'
import { V2Button, V2Row, V2TitleBlock } from './v2'
import { WarningRow } from './WarningRow'

/**
 * Install, update and `permissions.request` prompts as a v2 dialog (§1–§3: the panel colour,
 * radius 12, the dialog shadow; §9.23: a title block with the extension's icon, no bar and no
 * X). Main asks, the renderer shows what it will be able to do as rows with a glyph per kind,
 * and two buttons. One prompt at a time, oldest first; Escape, a press on the scrim and Cancel
 * all answer no.
 *
 * Rendered inside TabDialogs' `FrameDialogHost` (lib/portals.tsx), which centres the dialog in
 * the content frame over its §9.5 scrim – the frame alone dims; the sidebar and toolbar stay
 * undimmed. While a prompt is queued the content frame counts as covered
 * (`overlayCoversContent`): the page's view is hidden and the frame shows its capture, the way
 * every chrome overlay does; the dialog draws no tint of its own. On a finger the prompt is a
 * bottom sheet, on the body with the other sheets (whose §9.24 stack is their mount order
 * there), with the sheet's own scrim.
 */
export function ExtensionPromptDialog(): JSX.Element | null {
  const prompt = uiStore.use((s) => s.extensionPrompts[0] ?? null)
  const viewport = useViewport()
  if (!prompt) return null
  if (viewport.coarse) {
    return createPortal(<SheetPrompt key={prompt.requestId} prompt={prompt} />, document.body)
  }
  return <PanelPrompt key={prompt.requestId} prompt={prompt} />
}

interface Copy {
  title: string
  subtitle: string | null
  accept: string
}

/** The same words as the store service's native fallback prompt, per kind. */
function copyFor(prompt: ExtensionPromptRequest): Copy {
  switch (prompt.kind) {
    case 'request':
      return {
        title: `"${prompt.name}" wants additional permissions`,
        subtitle: null,
        accept: 'Allow'
      }
    case 'permissions':
      return {
        title: `"${prompt.name}" needs new permissions`,
        subtitle: 'It was updated and stays off until you allow them',
        accept: 'Allow'
      }
    case 'update':
      return {
        title: `Update "${prompt.name}"?`,
        subtitle: prompt.source ? fromSource(prompt.source) : null,
        accept: 'Update extension'
      }
    default:
      return {
        title: `Add "${prompt.name}"?`,
        subtitle: prompt.source ? fromSource(prompt.source) : null,
        accept: 'Add extension'
      }
  }
}

/** What the extension will be able to do, then the two buttons (§9.11). */
function PromptBody({
  prompt,
  onAnswer,
  onScroll
}: {
  prompt: ExtensionPromptRequest
  onAnswer: (accept: boolean) => void
  onScroll?: (scrolled: boolean) => void
}): JSX.Element {
  const copy = copyFor(prompt)
  return (
    <>
      <div
        className="zen-ext-dialog-body"
        onScroll={onScroll && ((e) => onScroll(e.currentTarget.scrollTop > 0))}
      >
        {prompt.warnings.length > 0 && <p className="zen-v2-caption">It can:</p>}
        <div className="zen-v2-rows">
          {prompt.warnings.length === 0 ? (
            <V2Row
              label={
                <span className="zen-v2-deemphasized">
                  {prompt.kind === 'permissions' || prompt.kind === 'request'
                    ? 'No new permissions are needed'
                    : 'This extension requires no special permissions'}
                </span>
              }
            />
          ) : (
            prompt.warnings.map((warning) => <WarningRow key={warning} warning={warning} />)
          )}
        </div>
      </div>
      <div className="zen-ext-dialog-buttons">
        <V2Button onClick={() => onAnswer(false)}>Cancel</V2Button>
        <V2Button variant="primary" data-accept onClick={() => onAnswer(true)}>
          {copy.accept}
        </V2Button>
      </div>
    </>
  )
}

/**
 * The desktop dialog: its panel in flow in the frame dialog host, which centres it and takes
 * the pointer over the frame; a press on the host's scrim answers no. Focus lands on the
 * accepting button, as Firefox's install prompt has it; Tab wraps inside; nothing in the chrome
 * opened it, so there is no control to return focus to (§9.22). A modal, not a popover: it
 * closes the popover open when it appears, a resize re-centres rather than closes it, and a
 * popover opening later does not dismiss it.
 */
function PanelPrompt({ prompt }: { prompt: ExtensionPromptRequest }): JSX.Element {
  const answer = (accept: boolean): void => answerExtensionPrompt(prompt, accept)
  const ref = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  useFrameDialog({ onScrimPress: () => answer(false) })
  usePopover(ref, {
    onClose: () => answer(false),
    anchored: false,
    claim: false,
    initial: (root) => root.querySelector<HTMLElement>('[data-accept]'),
    returnTo: null
  })
  const copy = copyFor(prompt)
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="zen-ext-dialog-title"
      className="zen-v2 zen-v2-dialog zen-ext-dialog zen-animate-pop"
    >
      <V2TitleBlock
        id="zen-ext-dialog-title"
        title={copy.title}
        description={copy.subtitle}
        glyph={<ExtensionIcon icon={prompt.icon} size={16} box={16} />}
        scrolled={scrolled}
      />
      <PromptBody prompt={prompt} onAnswer={answer} onScroll={setScrolled} />
    </div>
  )
}

/**
 * On a phone the prompt is a sheet: with a description it opens with a title block (§9.23),
 * without one it keeps the sheet's 48 header with the title centred (§9.16).
 */
function SheetPrompt({ prompt }: { prompt: ExtensionPromptRequest }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const answered = useRef(false)
  const answer = (accept: boolean): void => {
    if (answered.current) return
    answered.current = true
    sheet.current?.dismiss(() => answerExtensionPrompt(prompt, accept))
  }
  // Escape answers no – and, over another sheet, closes this one only (§9.24).
  useEscape(() => answer(false))
  const copy = copyFor(prompt)
  // The phone's glyph size (§9.23: 20 on a phone, 16 on desktop).
  const glyph = <ExtensionIcon icon={prompt.icon} size={20} box={20} />
  return (
    <BottomSheet
      ref={sheet}
      className="zen-v2-sheet"
      handleLabel="Resize"
      header={
        copy.subtitle ? (
          <V2TitleBlock
            className="zen-v2"
            surface="page"
            title={copy.title}
            description={copy.subtitle}
            glyph={glyph}
          />
        ) : (
          <div className="zen-v2 zen-v2-sheet-title" data-surface="page">
            {glyph}
            <span className="min-w-0">{copy.title}</span>
          </div>
        )
      }
      onDismissed={() => {
        // Dragged or flung away without a choice: that is a no.
        if (!answered.current) {
          answered.current = true
          answerExtensionPrompt(prompt, false)
        }
      }}
    >
      <div className="zen-v2 zen-ext-dialog" data-surface="page">
        <PromptBody prompt={prompt} onAnswer={answer} />
      </div>
    </BottomSheet>
  )
}
