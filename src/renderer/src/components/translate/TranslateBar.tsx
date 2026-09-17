import type { JSX, MouseEvent, ReactNode } from 'react'
import { Languages, MoreHorizontal, X } from 'lucide-react'
import type { TranslateTabState } from '@shared/translate'
import type { UIState } from '@shared/types'
import { languageName } from '@shared/languageNames'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { languageOptions, pairLabel, retarget } from '@renderer/lib/translate'
import { formatBytes } from '@renderer/lib/utils'
import { IconButton, Menulist, TranslateButton } from './controls'

/**
 * The translation bar: a strip at the top of the content frame that offers to translate a
 * page in another language, reports the model download and the translation as they run, and
 * puts the original back. The desktop bar carries menulists for the languages; the phone's
 * bar leaves them to the options menu (Firefox's gear, Chrome's "⋮") and shows the pair as a
 * caption instead. It lives in the frame's flow, so the page keeps its live view below it and
 * an offer never freezes the page behind a snapshot.
 */
export function TranslateBar({
  state,
  tab
}: {
  state: UIState
  tab: TranslateTabState
}): JSX.Element {
  const phone = useViewport().formFactor === 'phone'
  const { languages } = state.translate
  const tabId = tab.tabId

  const translate = (): void =>
    run('translate.page', {
      tabId,
      source: tab.source ?? undefined,
      target: tab.target ?? undefined
    })
  const revert = (): void => run('translate.revert', { tabId })
  /** The "×": drop the offer, or a translation still running (the original comes back). */
  const close = (): void => {
    if (tab.status === 'downloading' || tab.status === 'translating') revert()
    run('translate.dismiss', { tabId })
  }
  const options = (e: MouseEvent<HTMLElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    run('translate.menu', { tabId, x: Math.round(r.left), y: Math.round(r.bottom) })
  }

  const sourceList = (
    <Menulist
      value={tab.source}
      options={languageOptions(languages, tab.target)}
      onChange={(source) => retarget(tab, { source })}
      label="Page language"
      placeholder="Choose a language"
    />
  )
  const targetList = (
    <Menulist
      value={tab.target}
      options={languageOptions(languages, tab.source)}
      onChange={(target) => retarget(tab, { target })}
      label="Translate to"
      placeholder="Choose a language"
    />
  )

  const progress = progressOf(tab)
  const showOptions =
    tab.status === 'offered' || tab.status === 'translating' || tab.status === 'translated'

  let body: ReactNode
  if (phone) {
    body = <PhoneBody tab={tab} translate={translate} revert={revert} />
  } else {
    switch (tab.status) {
      case 'offered':
        body = (
          <>
            <span>Translate from</span>
            {sourceList}
            <span>to</span>
            {targetList}
            <TranslateButton primary disabled={!tab.source || !tab.target} onClick={translate}>
              Translate
            </TranslateButton>
          </>
        )
        break
      case 'downloading':
        body = (
          <>
            <span className="truncate">
              Getting the {pairLabel(tab.source, tab.target)} model
              {tab.download ? ` (${downloadLabel(tab.download)})` : ''}…
            </span>
            <TranslateButton onClick={close}>Cancel</TranslateButton>
          </>
        )
        break
      case 'translating':
        body = (
          <>
            <span className="truncate">
              Translating from {languageName(tab.source ?? '')} to {languageName(tab.target ?? '')}…
              {tab.progress && tab.progress.total > 0 && (
                <span className="zen-translate-caption tabular-nums">
                  {' '}
                  {tab.progress.done} of {tab.progress.total}
                </span>
              )}
            </span>
            <TranslateButton onClick={revert}>Show original</TranslateButton>
          </>
        )
        break
      case 'translated':
        body = (
          <>
            <span>Translated from</span>
            {sourceList}
            <span>to</span>
            {targetList}
            <TranslateButton onClick={revert}>Show original</TranslateButton>
          </>
        )
        break
      default:
        body = (
          <>
            <span className="truncate">
              <span className="zen-translate-danger">Translation failed.</span>
              {tab.error ? ` ${tab.error}` : ''}
            </span>
            <TranslateButton onClick={translate} disabled={!tab.source || !tab.target}>
              Try again
            </TranslateButton>
          </>
        )
    }
  }

  return (
    <div
      className="zen-translate-bar zen-animate-in"
      role="region"
      aria-label="Translation"
      data-status={tab.status}
    >
      <Languages className="zen-translate-glyph" aria-hidden />
      {body}
      {!phone && <span className="flex-1" />}
      {showOptions && (
        <IconButton label="Translation options" onClick={options}>
          <MoreHorizontal />
        </IconButton>
      )}
      <IconButton label="Close" onClick={close}>
        <X />
      </IconButton>
      {progress !== null && (
        <span
          className="zen-translate-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          style={{ transform: `scaleX(${progress})` }}
        />
      )}
    </div>
  )
}

/** The phone's two lines and one button: what is happening, and to which pair. */
function PhoneBody({
  tab,
  translate,
  revert
}: {
  tab: TranslateTabState
  translate: () => void
  revert: () => void
}): JSX.Element {
  const pair = pairLabel(tab.source, tab.target)
  let title: string
  let caption: string
  let action: ReactNode = null
  switch (tab.status) {
    case 'offered':
      title = 'Translate this page?'
      caption = tab.source ? pair : 'Choose the page language in the options'
      action = (
        <TranslateButton primary disabled={!tab.source || !tab.target} onClick={translate}>
          Translate
        </TranslateButton>
      )
      break
    case 'downloading':
      title = 'Getting the translation model'
      caption = tab.download ? `${pair} · ${downloadLabel(tab.download)}` : pair
      break
    case 'translating':
      title = 'Translating…'
      caption =
        tab.progress && tab.progress.total > 0
          ? `${pair} · ${tab.progress.done} of ${tab.progress.total}`
          : pair
      action = <TranslateButton onClick={revert}>Original</TranslateButton>
      break
    case 'translated':
      title = 'Translated'
      caption = pair
      action = <TranslateButton onClick={revert}>Original</TranslateButton>
      break
    default:
      title = 'Translation failed'
      caption = tab.error ?? pair
      action = (
        <TranslateButton onClick={translate} disabled={!tab.source || !tab.target}>
          Try again
        </TranslateButton>
      )
  }
  return (
    <>
      <span className="zen-translate-text">
        <span className="block truncate">{title}</span>
        <span className="zen-translate-caption block truncate">{caption}</span>
      </span>
      {action}
    </>
  )
}

/** 0…1 while a model downloads or a page translates; null when there is nothing to measure. */
function progressOf(tab: TranslateTabState): number | null {
  if (tab.status === 'downloading' && tab.download && tab.download.total > 0)
    return Math.min(1, tab.download.received / tab.download.total)
  if (tab.status === 'translating' && tab.progress && tab.progress.total > 0)
    return Math.min(1, tab.progress.done / tab.progress.total)
  return null
}

function downloadLabel(download: { received: number; total: number }): string {
  return download.total > 0
    ? `${formatBytes(download.received)} of ${formatBytes(download.total)}`
    : formatBytes(download.received)
}
