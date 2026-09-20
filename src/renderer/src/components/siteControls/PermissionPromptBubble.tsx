import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  Bell,
  Bluetooth,
  Camera,
  Cable,
  ClipboardCopy,
  Cookie,
  Download,
  ExternalLink,
  FolderOpen,
  Gamepad2,
  Glasses,
  Lock,
  MapPin,
  Mic,
  MonitorUp,
  Music,
  ScreenShare,
  ShieldCheck,
  Usb,
  Video,
  Wifi,
  type LucideIcon
} from 'lucide-react'
import type { PermissionPrompt, PermissionPromptAnswer, UIState } from '@shared/types'
import { contentSettingId } from '@shared/contentSettings'
import { POPOVER_WIDTH } from '@renderer/lib/portals'
import {
  answerPermissionPrompt,
  closePermissionPrompt,
  currentPermissionPrompt,
  openPermissionPrompt
} from '@renderer/lib/security'
import { V2_GLYPH, V2Button } from '../v2/controls'
import { siteChip, siteChipRects, usePhone } from '@renderer/lib/surfaces'
import { DesktopPopover, Footer, TitleBlock, V2Sheet, type SheetApi } from './primitives'

const GLYPHS: Record<string, LucideIcon> = {
  camera: Camera,
  microphone: Mic,
  media: Video,
  geolocation: MapPin,
  notifications: Bell,
  midi: Music,
  midiSysex: Music,
  'clipboard-read': ClipboardCopy,
  'window-management': MonitorUp,
  'idle-detection': Activity,
  fileSystem: FolderOpen,
  openExternal: ExternalLink,
  'storage-access': Cookie,
  'top-level-storage-access': Cookie,
  mediaKeySystem: Lock,
  'automatic-downloads': Download,
  'display-capture': ScreenShare,
  usb: Usb,
  serial: Cable,
  hid: Gamepad2,
  bluetooth: Bluetooth,
  xr: Glasses,
  'local-network-access': Wifi
}

/**
 * Permission prompts ("Allow example.com to use your camera?"), non-modal, one at a time over the
 * page that asked: a prompt waits until its tab is the active one. On a mouse it is a 400 px
 * popover under the site icon in the address pill (design language v2 §9.20) opening on a title
 * block (§9.23) – the permission's glyph, the question, one sentence on what is remembered – and
 * a hugging footer: Block, Allow once, Allow. A prompt a page event raised beside a chip takes
 * NO focus on open (§9.22's notice rule: the user is reading the page); its "not now" – Escape,
 * a press outside, a scroll away – collapses it back into the chip (the pop reversed toward the
 * anchor, 180 ms, §9.20), and the chip stays in the pill at its rest ink, nothing lit or badged.
 * Without a chip (compact mode hides the pill) the prompt is the only affordance and takes focus
 * into its container as a title-and-notice panel does. On a phone the same prompt is a sheet
 * (§9.23, §9.11) with its actions full width, Allow first. Answers go back to the core
 * (`permissions.respond`), which remembers Allow and Block for the site, keeps Allow once for the
 * tab, and refuses a dismissed request this once: Escape, a press outside and the system back
 * gesture dismiss. The answered prompt leaves on the spring before the next one comes in.
 */
export function PermissionPrompts({ state }: { state: UIState }): JSX.Element | null {
  const current = currentPermissionPrompt(state)
  // The prompt on show: the core's current one once there is one, kept while its surface leaves
  // after the core moved on (answered, withdrawn, another tab in front). Settled during render,
  // so the surface for the next prompt never waits on an effect.
  const [shown, setShown] = useState<PermissionPrompt | null>(null)
  let prompt = shown
  if (current && shown === null) {
    prompt = current
    setShown(current)
  }
  const closing = prompt !== null && prompt.id !== current?.id
  const onClosed = useCallback(() => setShown(null), [])
  const phone = usePhone()
  if (!prompt) return null
  return phone ? (
    <PromptSheet key={prompt.id} prompt={prompt} closing={closing} onClosed={onClosed} />
  ) : (
    <PromptBubble key={prompt.id} prompt={prompt} closing={closing} onClosed={onClosed} />
  )
}

interface SurfaceProps {
  prompt: PermissionPrompt
  /** The core took the question back or the answer went out: leave now. */
  closing: boolean
  onClosed: () => void
}

/**
 * The page's views hide under chrome surfaces; its snapshot stands in while the prompt is up.
 * The surface shows once the picture is there (or the short wait for it is over) and answers
 * once; how it is dismissed – Escape, a press outside, the sheet pulled down or the system back
 * gesture – is the surface's business, and each of those ends in `respond('dismiss')`.
 */
function usePrompt(prompt: PermissionPrompt): {
  ready: boolean
  /** The prompt went unanswered ("not now"): the popover folds back into its chip. */
  dismissed: boolean
  respond: (answer: PermissionPromptAnswer) => void
} {
  const [ready, setReady] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const answered = useRef(false)
  useEffect(() => {
    let gone = false
    void openPermissionPrompt(prompt.tabId).then(() => {
      if (gone) closePermissionPrompt()
      else setReady(true)
    })
    return () => {
      gone = true
      closePermissionPrompt()
    }
  }, [prompt.tabId])
  const respond = useCallback(
    (answer: PermissionPromptAnswer): void => {
      if (answered.current) return
      answered.current = true
      if (answer === 'dismiss') setDismissed(true)
      answerPermissionPrompt(prompt.id, answer)
    },
    [prompt.id]
  )
  return { ready, dismissed, respond }
}

function glyphFor(prompt: PermissionPrompt): JSX.Element {
  const Glyph =
    GLYPHS[prompt.permission] ?? GLYPHS[contentSettingId(prompt.permission)] ?? ShieldCheck
  return <Glyph className={V2_GLYPH} aria-hidden />
}

function detailLines(prompt: PermissionPrompt): string[] {
  return prompt.detail.split('\n').filter((line) => line.length > 0)
}

function PromptBubble({ prompt, closing, onClosed }: SurfaceProps): JSX.Element | null {
  const { ready, dismissed, respond } = usePrompt(prompt)
  const [rects, setRects] = useState(siteChipRects)
  // The bubble follows the pill through a window resize rather than leaving (`follow`): the
  // page is still waiting for its answer.
  useEffect(() => {
    const measure = (): void => setRects(siteChipRects())
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [ready])
  const dismiss = useCallback(() => respond('dismiss'), [respond])
  const titleId = `permission-prompt-${prompt.id}`
  if (!ready) return null
  const lines = detailLines(prompt)
  // Beside its chip the prompt is a notice: no focus on open, and its "not now" folds it back
  // into the chip (§9.20, §9.22). With the pill hidden it is the only affordance: it takes the
  // container and leaves on the spring as any popover.
  const chip = rects.anchor !== null
  return (
    <DesktopPopover
      anchor={rects.anchor}
      bar={rects.bar}
      width={POPOVER_WIDTH.form}
      labelledBy={titleId}
      closing={closing}
      collapse={chip && dismissed}
      onClosed={onClosed}
      onDismiss={dismiss}
      focus={chip ? 'none' : 'container'}
      follow
      anchorElement={siteChip}
      data-testid="permission-prompt"
      data-permission={prompt.permission}
      data-chip={chip ? '' : undefined}
    >
      {() => (
        <>
          <TitleBlock
            id={titleId}
            glyph={glyphFor(prompt)}
            title={prompt.message}
            description={
              lines.length > 0
                ? lines.map((line, i) => (
                    <span key={i} className="block">
                      {line}
                    </span>
                  ))
                : undefined
            }
          />
          <Footer count={prompt.allowOnce ? 3 : 2} hairline={false} className="pt-0 pb-4">
            <V2Button onClick={() => respond('block')}>{prompt.blockLabel}</V2Button>
            {prompt.allowOnce && (
              <V2Button onClick={() => respond('allow-once')}>Allow once</V2Button>
            )}
            <V2Button variant="primary" onClick={() => respond('allow')}>
              {prompt.allowLabel}
            </V2Button>
          </Footer>
        </>
      )}
    </DesktopPopover>
  )
}

function PromptSheet({ prompt, closing, onClosed }: SurfaceProps): JSX.Element | null {
  const { ready, respond } = usePrompt(prompt)
  const api = useRef<SheetApi | null>(null)
  useEffect(() => {
    if (closing) api.current?.dismiss()
  }, [closing])
  const titleId = `permission-prompt-${prompt.id}`
  if (!ready) return null
  const lines = detailLines(prompt)
  const three = prompt.allowOnce
  return (
    <V2Sheet
      name="permission-prompt"
      api={api}
      handleLabel="Resize permission prompt"
      labelledBy={titleId}
      // A pull-down or scrim tap is the same "not now" as Escape; the core hears it once.
      onDismissed={() => {
        respond('dismiss')
        onClosed()
      }}
      titleBlock={
        <TitleBlock
          id={titleId}
          glyph={glyphFor(prompt)}
          title={prompt.message}
          description={
            lines.length > 0
              ? lines.map((line, i) => (
                  <span key={i} className="block">
                    {line}
                  </span>
                ))
              : undefined
          }
        />
      }
      footer={
        <Footer count={three ? 3 : 2}>
          {three ? (
            <>
              <V2Button variant="primary" onClick={() => respond('allow')}>
                {prompt.allowLabel}
              </V2Button>
              <V2Button onClick={() => respond('allow-once')}>Allow once</V2Button>
              <V2Button onClick={() => respond('block')}>{prompt.blockLabel}</V2Button>
            </>
          ) : (
            <>
              <V2Button onClick={() => respond('block')}>{prompt.blockLabel}</V2Button>
              <V2Button variant="primary" onClick={() => respond('allow')}>
                {prompt.allowLabel}
              </V2Button>
            </>
          )}
        </Footer>
      }
      data-testid="permission-prompt"
      data-permission={prompt.permission}
    >
      {null}
    </V2Sheet>
  )
}
