import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import {
  Activity,
  Bell,
  Camera,
  ClipboardCopy,
  Cookie,
  Download,
  ExternalLink,
  FolderOpen,
  Lock,
  MapPin,
  Mic,
  MonitorUp,
  Music,
  ShieldCheck,
  Video,
  type LucideIcon
} from 'lucide-react'
import type { PermissionPrompt, PermissionPromptAnswer, UIState } from '@shared/types'
import { useBackSurface } from '@renderer/lib/back'
import { useFrameDialog } from '@renderer/lib/portals'
import {
  answerPermissionPrompt,
  closePermissionPrompt,
  currentPermissionPrompt,
  openPermissionPrompt
} from '@renderer/lib/security'
import { Button } from '../ui/button'

const GLYPHS: Record<string, LucideIcon> = {
  camera: Camera,
  microphone: Mic,
  media: Video,
  geolocation: MapPin,
  notifications: Bell,
  midi: Music,
  'clipboard-read': ClipboardCopy,
  'window-management': MonitorUp,
  'idle-detection': Activity,
  fileSystem: FolderOpen,
  openExternal: ExternalLink,
  'storage-access': Cookie,
  'top-level-storage-access': Cookie,
  mediaKeySystem: Lock,
  'automatic-downloads': Download
}

/**
 * Permission prompts, one at a time over the page they belong to: a prompt waits until its tab is
 * the active one. Answers go back to the core (`permissions.respond`), which remembers Allow and
 * Block for the site, keeps Allow once for the tab, and refuses a dismissed request this once.
 * Rendered inside TabDialogs' `FrameDialogHost`, which centres the prompt in the content frame;
 * a press on its scrim dismisses, as a click outside the bubble does in Chrome.
 */
export function PermissionPrompts({ state }: { state: UIState }): JSX.Element | null {
  const prompt = currentPermissionPrompt(state)
  if (!prompt) return null
  return <PermissionPromptDialog key={prompt.id} prompt={prompt} />
}

function PermissionPromptDialog({ prompt }: { prompt: PermissionPrompt }): JSX.Element {
  const answered = useRef(false)
  const allowButton = useRef<HTMLButtonElement>(null)

  // The page's views hide under chrome overlays; its snapshot stands in while the prompt is up.
  useEffect(() => {
    let gone = false
    void openPermissionPrompt(prompt.tabId).then(() => {
      if (gone) closePermissionPrompt()
      else allowButton.current?.focus()
    })
    return () => {
      gone = true
      closePermissionPrompt()
    }
  }, [prompt.tabId])

  const respond = (answer: PermissionPromptAnswer): void => {
    if (answered.current) return
    answered.current = true
    answerPermissionPrompt(prompt.id, answer)
  }

  // Escape, a click outside, and the system back gesture or button on Android dismiss: the site
  // is refused this once and may ask again (three dismissals in a row block it).
  useBackSurface({ name: 'permission-prompt', onCommit: () => respond('dismiss') })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      respond('dismiss')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  useFrameDialog({ onScrimPress: () => respond('dismiss') })

  const Glyph = GLYPHS[prompt.permission] ?? ShieldCheck
  const lines = prompt.detail.split('\n').filter((line) => line.length > 0)
  return (
    <div
      className="zen-panel zen-animate-pop mt-12 w-[400px] max-w-[calc(100%-32px)] self-start overflow-hidden"
      role="dialog"
      aria-labelledby={`permission-prompt-${prompt.id}`}
      data-testid="permission-prompt"
      data-permission={prompt.permission}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[var(--zen-element-bg)]">
            <Glyph className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={`permission-prompt-${prompt.id}`} className="text-[15px] font-semibold">
              {prompt.message}
            </h2>
            {lines.map((line, i) => (
              <p key={i} className="mt-0.5 break-words text-[12.5px] text-[var(--zen-muted)]">
                {line}
              </p>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={() => respond('block')}>
            {prompt.blockLabel}
          </Button>
          {prompt.allowOnce && (
            <Button variant="secondary" onClick={() => respond('allow-once')}>
              Allow once
            </Button>
          )}
          <Button ref={allowButton} onClick={() => respond('allow')}>
            {prompt.allowLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
