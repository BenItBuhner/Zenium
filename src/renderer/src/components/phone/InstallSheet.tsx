import type { JSX } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { WebAppInstallPrompt } from '@shared/types'
import { tileInk, tileLetter, type WebAppScreenshot } from '@shared/webApp'
import { cmd, run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { useFrameDialog } from '@renderer/lib/portals'
import { closeInstallSheet, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useEscapeTrap } from '../bookmarks/escape'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

const TITLE_ID = 'zen-install-title'
const NAME_FIELD_ID = 'zen-install-name'

/** "Add to Home screen" while a prompt is open, in the frame dialog host `TabDialogs` mounts. */
export function InstallLayer(): JSX.Element | null {
  const prompt = uiStore.use((s) => s.install)
  return prompt ? <InstallSheet key={prompt.tabId} prompt={prompt} /> : null
}

/**
 * The install sheet on the v2 sheet chassis (`BottomSheet`: surface, grip, 48 header, footer),
 * placed through `FrameDialogHost` and drawing the stack's one scrim itself. With a manifest it
 * presents the app – tile, name, origin, description and a screenshot strip – and one primary
 * "Add"; without one it is the lighter name-edit sheet: the page's tile beside a labelled name
 * field (§9.12) with the origin as its description. "Add" goes busy (§9.30) while the core has
 * the host fetch the icon and hand the request to the launcher, then the sheet slides away under
 * the system's own pin dialog; every other way out (Cancel, scrim, drag, back, Escape) reports a
 * cancelled install so a site's deferred `prompt()` learns of it.
 */
function InstallSheet({ prompt }: { prompt: WebAppInstallPrompt }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const [title, setTitle] = useState(prompt.title)
  const [busy, setBusy] = useState(false)
  const accepted = useRef(false)
  const info = prompt.info

  const dismiss = useCallback(() => sheet.current?.dismiss(), [])
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useEscapeTrap(true, dismiss)
  useBackSurface({
    name: 'install',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })

  const name = title.trim() || prompt.title
  const add = async (): Promise<void> => {
    if (accepted.current) return
    accepted.current = true
    setBusy(true)
    // Resolves once the request reached the launcher (its dialog is up) or could not be made
    // (the core toasts the failure); either way the sheet is done.
    await cmd('webapp.pin', { tabId: prompt.tabId, title: name }).catch(() => undefined)
    sheet.current?.dismiss()
  }
  const onDismissed = (): void => {
    if (!accepted.current) run('webapp.cancelInstall', { tabId: prompt.tabId })
    closeInstallSheet(prompt.tabId)
  }

  return (
    <BottomSheet
      ref={sheet}
      hosted
      className="zen-install-sheet"
      labelledBy={TITLE_ID}
      onDismissed={onDismissed}
      contentKey={`${prompt.tabId}:${info ? 'app' : 'page'}`}
      header={
        <h2 id={TITLE_ID} className="zen-sheet-title">
          Add to Home screen
        </h2>
      }
      footer={
        <>
          <button type="button" className="zen-v2-button" onClick={dismiss}>
            Cancel
          </button>
          <button
            type="button"
            className="zen-v2-button"
            data-primary
            aria-label="Add"
            aria-busy={busy || undefined}
            onClick={() => void add()}
          >
            {busy ? <Loader2 className="zen-spin h-4 w-4" strokeWidth={2} aria-hidden /> : 'Add'}
          </button>
        </>
      }
    >
      <div className="zen-install-body">
        <div className="zen-install-app">
          <AppIcon icon={prompt.icon} name={name} tint={prompt.tint} size={56} />
          {info ? (
            <div className="min-w-0 flex-1">
              <div className="zen-install-name truncate">{info.name}</div>
              <div className="zen-install-detail truncate">{prompt.origin}</div>
            </div>
          ) : (
            <div className="zen-install-form min-w-0 flex-1">
              <label htmlFor={NAME_FIELD_ID} className="zen-install-label">
                Name
              </label>
              <input
                id={NAME_FIELD_ID}
                className="zen-v2-field"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add()
                }}
                maxLength={60}
                autoCapitalize="words"
                autoCorrect="off"
                spellCheck={false}
                placeholder={prompt.title}
              />
              <div className="zen-install-detail truncate">{prompt.origin}</div>
            </div>
          )}
        </div>
        {info?.description && <p className="zen-install-description">{info.description}</p>}
        {info && info.screenshots.length > 0 && <ScreenshotStrip shots={info.screenshots} />}
      </div>
    </BottomSheet>
  )
}

/**
 * The app's icon at `size`, or a letter tile when there is none (or it fails to load). The tile
 * is the launcher's: the core's `tint` (the manifest's theme colour, else the space accent) with
 * the ink its luminance calls for and the title's first letter as one code point (`tileInk`,
 * `tileLetter`, the rules `ShortcutTile.kt` paints by), so the preview matches what gets pinned.
 * Without a tint it sits on the v2 accent with its ink (`.zen-install-icon[data-letter]`).
 */
export function AppIcon({
  icon,
  name,
  tint,
  size
}: {
  icon: string | null
  name: string
  tint: string | null
  size: number
}): JSX.Element {
  const [broken, setBroken] = useState<string | null>(null)
  const src = icon && broken !== icon ? icon : null
  const tile = src ? null : tint
  return (
    <span
      className="zen-install-icon shrink-0"
      data-letter={src ? undefined : ''}
      style={{
        width: size,
        height: size,
        background: tile ?? undefined,
        color: tile ? tileInk(tile) : undefined,
        fontSize: Math.round(size * 0.46)
      }}
      aria-hidden
    >
      {src ? (
        <img src={src} alt="" draggable={false} onError={() => setBroken(icon)} />
      ) : (
        tileLetter(name)
      )}
    </span>
  )
}

const SHOT_HEIGHT = 240

/** Width for a screenshot from its declared `sizes`, before the image itself has loaded. */
function shotWidth(shot: WebAppScreenshot): number | null {
  const m = shot.sizes ? /^(\d+)x(\d+)/.exec(shot.sizes) : null
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  if (!w || !h) return null
  return Math.round((SHOT_HEIGHT * w) / h)
}

/**
 * The manifest's screenshots as a horizontal strip of bordered cards: fixed height, natural
 * width, one snap stop per shot and fading edges where more is hidden. Phone-shaped (`narrow`)
 * shots are shown when the manifest has any; the rest only otherwise.
 */
function ScreenshotStrip({ shots }: { shots: WebAppScreenshot[] }): JSX.Element {
  const fadeRef = useFadeEdges<HTMLDivElement>({ axis: 'x', size: 20 })
  const visible = useMemo(() => {
    const narrow = shots.filter((s) => s.formFactor === 'narrow')
    return narrow.length ? narrow : shots
  }, [shots])
  return (
    <div ref={fadeRef} className="zen-install-shots" role="list" aria-label="Screenshots">
      {visible.map((shot) => (
        <figure
          key={shot.src}
          role="listitem"
          className={cn('zen-install-shot', !shotWidth(shot) && 'min-w-[96px]')}
          data-sized={shotWidth(shot) ? '' : undefined}
          style={{ height: SHOT_HEIGHT, width: shotWidth(shot) ?? undefined }}
        >
          <img
            src={shot.src}
            alt={shot.label ?? ''}
            height={SHOT_HEIGHT}
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        </figure>
      ))}
    </div>
  )
}
