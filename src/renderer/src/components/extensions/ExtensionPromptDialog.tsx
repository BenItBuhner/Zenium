import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ExtensionPromptRequest } from '@shared/types'
import { answerExtensionPrompt } from '@renderer/lib/extensions/popup'
import { sourceLabel } from '@renderer/lib/extensions/storeInput'
import { useViewport } from '@renderer/lib/formFactor'
import { contentAreaStore, uiStore } from '@renderer/lib/ui'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { ExtensionIcon } from './ExtensionIcon'
import { V2Button, V2Row } from './v2'
import { WarningRow } from './WarningRow'

/**
 * Install, update and `permissions.request` prompts as a v2 dialog (§1–§3: the panel colour,
 * radius 12, the dialog shadow; §9.5: only the content frame dims, the sidebar and toolbar stay
 * undimmed and inert). Main asks, the renderer shows the extension's icon, what it will be able
 * to do as rows with a glyph per kind, and two buttons. One prompt at a time, oldest first;
 * Escape, a click outside and Cancel all answer no. On a finger it is a bottom sheet.
 *
 * While a prompt is queued the content frame counts as covered (`overlayCoversContent`): the
 * page's view is hidden and the frame shows its dimmed capture, the way every chrome overlay
 * does, so the dialog itself draws no tint.
 */
export function ExtensionPromptDialog(): JSX.Element | null {
  const prompt = uiStore.use((s) => s.extensionPrompts[0] ?? null)
  const viewport = useViewport()
  if (!prompt) return null
  return createPortal(
    viewport.coarse ? (
      <SheetPrompt key={prompt.requestId} prompt={prompt} />
    ) : (
      <PanelPrompt key={prompt.requestId} prompt={prompt} />
    ),
    document.body
  )
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
        subtitle: prompt.source ? `From ${sourceLabel(prompt.source)}` : null,
        accept: 'Update extension'
      }
    default:
      return {
        title: `Add "${prompt.name}"?`,
        subtitle: prompt.source ? `From ${sourceLabel(prompt.source)}` : null,
        accept: 'Add extension'
      }
  }
}

function PromptBody({
  prompt,
  onAnswer
}: {
  prompt: ExtensionPromptRequest
  onAnswer: (accept: boolean) => void
}): JSX.Element {
  const copy = copyFor(prompt)
  const accept = useRef<HTMLButtonElement>(null)
  useEffect(() => accept.current?.focus(), [])
  return (
    <>
      <div className="zen-ext-dialog-head">
        <ExtensionIcon icon={prompt.icon} size={32} box={32} className="zen-ext-dialog-icon" />
        <div className="min-w-0 flex-1">
          <h2 className="zen-ext-dialog-title">{copy.title}</h2>
          {copy.subtitle && <p className="zen-ext-dialog-sub">{copy.subtitle}</p>}
        </div>
      </div>
      <div className="flex flex-col">
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
        <V2Button ref={accept} variant="primary" onClick={() => onAnswer(true)}>
          {copy.accept}
        </V2Button>
      </div>
    </>
  )
}

function PanelPrompt({ prompt }: { prompt: ExtensionPromptRequest }): JSX.Element {
  const answer = (accept: boolean): void => answerExtensionPrompt(prompt, accept)
  const area = contentAreaStore.use((s) => s.area)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      answerExtensionPrompt(prompt, false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [prompt])
  // The dialog is centred on the content frame; the transparent layer over the whole window
  // keeps the sidebar and toolbar inert until the prompt is answered, and any click outside the
  // dialog answers no.
  const frame = area ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
  return (
    <div
      className="zen-v2 fixed inset-0 z-[95]"
      onMouseDown={(e) => {
        e.stopPropagation()
        answer(false)
      }}
    >
      <div
        className="absolute flex items-center justify-center"
        style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={copyFor(prompt).title}
          className="zen-v2-dialog zen-ext-dialog zen-animate-pop"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <PromptBody prompt={prompt} onAnswer={answer} />
        </div>
      </div>
    </div>
  )
}

function SheetPrompt({ prompt }: { prompt: ExtensionPromptRequest }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const answered = useRef(false)
  const answer = (accept: boolean): void => {
    if (answered.current) return
    answered.current = true
    sheet.current?.dismiss(() => answerExtensionPrompt(prompt, accept))
  }
  return (
    <BottomSheet
      ref={sheet}
      handleLabel="Resize"
      onDismissed={() => {
        // Dragged or flung away without a choice: that is a no.
        if (!answered.current) {
          answered.current = true
          answerExtensionPrompt(prompt, false)
        }
      }}
    >
      <div className="zen-v2 zen-ext-dialog">
        <PromptBody prompt={prompt} onAnswer={answer} />
      </div>
    </BottomSheet>
  )
}
