import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { WebAppInstallPrompt } from '@shared/types'
import { tileInk, tileLetter, type WebAppScreenshot } from '@shared/webApp'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { closeInstallSheet, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/** "Add to Home screen" floats above whichever shell is up while a prompt is open. */
export function InstallLayer(): JSX.Element | null {
  const prompt = uiStore.use((s) => s.install)
  return prompt ? <InstallSheet key={prompt.tabId} prompt={prompt} /> : null
}

/**
 * The install sheet: the menu sheet's motion under a v2 dialog surface. With a manifest it
 * presents the app – icon, name, origin, description and a screenshot strip – and one primary
 * "Add"; without one it is the lighter name-edit sheet with the page's icon and a title field.
 * Either way "Add" slides the sheet away and asks the core to pin, which brings up the system's
 * own pin dialog; every other way out (Cancel, scrim, drag, back, Escape) reports a cancelled
 * install so a site's deferred `prompt()` learns of it.
 */
function InstallSheet({ prompt }: { prompt: WebAppInstallPrompt }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const body = useRef<HTMLDivElement>(null)
  const [title, setTitle] = useState(prompt.title)
  const accepted = useRef(false)
  const info = prompt.info

  useBackSurface({
    name: 'install',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      sheet.current?.dismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  // The header shows a hairline only while the body is scrolled under it (main.css).
  useEffect(() => {
    const scroller = body.current?.parentElement
    const surface = scroller?.closest<HTMLElement>('.zen-sheet')
    if (!scroller || !surface) return
    const update = (): void => {
      surface.dataset.scrolled = String(scroller.scrollTop > 0)
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', update)
      delete surface.dataset.scrolled
    }
  }, [])

  const name = title.trim() || prompt.title
  const add = (): void => {
    if (accepted.current) return
    accepted.current = true
    sheet.current?.dismiss(() => run('webapp.pin', { tabId: prompt.tabId, title: name }))
  }
  const onDismissed = (): void => {
    if (!accepted.current) run('webapp.cancelInstall', { tabId: prompt.tabId })
    closeInstallSheet(prompt.tabId)
  }

  return (
    <BottomSheet
      ref={sheet}
      className="zen-install-sheet"
      onDismissed={onDismissed}
      contentKey={`${prompt.tabId}:${info ? 'app' : 'page'}`}
      handleLabel="Resize sheet"
      header={<h2 className="zen-install-title truncate">Add to Home Screen</h2>}
      footer={
        // Two peers split the footer equally with an 8 px gap, the primary trailing (draft 9.11).
        <div className="flex gap-2 pb-2 pt-4">
          <button
            type="button"
            className="zen-v2-button flex-1"
            onClick={() => sheet.current?.dismiss()}
          >
            Cancel
          </button>
          <button type="button" className="zen-v2-button flex-1" data-primary onClick={add}>
            Add
          </button>
        </div>
      }
    >
      <div ref={body} className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <AppIcon icon={prompt.icon} name={name} tint={prompt.tint} size={56} />
          <div className="min-w-0 flex-1">
            {info ? (
              <div className="zen-install-name truncate">{info.name}</div>
            ) : (
              <input
                className="zen-v2-field"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') add()
                }}
                maxLength={60}
                autoCapitalize="words"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Shortcut name"
                placeholder={prompt.title}
              />
            )}
            <div className={cn('zen-install-detail truncate', info ? 'mt-0.5' : 'mt-1')}>
              {prompt.origin}
            </div>
          </div>
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
