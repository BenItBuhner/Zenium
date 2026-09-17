import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ExtensionPromptRequest } from '@shared/types'
import { answerExtensionPrompt } from '@renderer/lib/extensions/popup'
import { sourceLabel } from '@renderer/lib/extensions/storeInput'
import { useViewport } from '@renderer/lib/formFactor'
import { uiStore } from '@renderer/lib/ui'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { Note } from '../overlays/SettingsPrimitives'
import { Button } from '../ui/button'
import { ExtensionIcon } from './ExtensionIcon'
import { WarningRow } from './WarningRow'

/**
 * Install, update and `permissions.request` prompts (design-language.md §8.1 dialog): main asks,
 * the renderer shows the extension's icon in a pill tint, what it will be able to do as rows
 * with a glyph per kind, and two buttons. One prompt at a time, oldest first; Escape, the scrim
 * and Cancel all answer no.
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

function copyFor(prompt: ExtensionPromptRequest): Copy {
  switch (prompt.kind) {
    case 'permissions':
      return {
        title: `"${prompt.name}" wants additional permissions`,
        subtitle: null,
        accept: 'Allow'
      }
    case 'update':
      return {
        title: `Update "${prompt.name}"?`,
        subtitle: 'The new version needs more permissions',
        accept: 'Update'
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
      <div className="flex items-center gap-3">
        <span className="zen-ext-dialog-icon">
          <ExtensionIcon icon={prompt.icon} size={32} box={48} glyphClassName="text-current" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="zen-ext-dialog-title">{copy.title}</h2>
          {copy.subtitle && <p className="zen-ext-dialog-sub">{copy.subtitle}</p>}
        </div>
      </div>
      <div className="flex flex-col">
        {prompt.warnings.length > 0 && <p className="zen-ext-caption mb-1">It can</p>}
        {prompt.warnings.length === 0 ? (
          <Note>
            {prompt.kind === 'permissions'
              ? 'No new permissions are needed'
              : 'This extension requires no special permissions'}
          </Note>
        ) : (
          prompt.warnings.map((warning) => <WarningRow key={warning} warning={warning} />)
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => onAnswer(false)}>
          Cancel
        </Button>
        <Button ref={accept} onClick={() => onAnswer(true)}>
          {copy.accept}
        </Button>
      </div>
    </>
  )
}

function PanelPrompt({ prompt }: { prompt: ExtensionPromptRequest }): JSX.Element {
  const answer = (accept: boolean): void => answerExtensionPrompt(prompt, accept)
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
  return (
    <div
      className="zen-overlay-scrim zen-animate-fade fixed inset-0 z-[95] flex items-center justify-center"
      onMouseDown={(e) => {
        e.stopPropagation()
        answer(false)
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={copyFor(prompt).title}
        className="zen-panel zen-ext-dialog zen-animate-pop"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <PromptBody prompt={prompt} onAnswer={answer} />
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
      <div className="zen-ext-dialog">
        <PromptBody prompt={prompt} onAnswer={answer} />
      </div>
    </BottomSheet>
  )
}
