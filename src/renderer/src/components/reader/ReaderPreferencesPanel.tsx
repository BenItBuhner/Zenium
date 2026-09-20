import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ALargeSmall, Minus, Plus } from 'lucide-react'
import type { Rect, UIState } from '@shared/types'
import { READER_URL_PREFIX } from '@shared/url'
import {
  READER_FONTS,
  READER_FONT_LABELS,
  READER_FONT_SIZES,
  READER_THEMES,
  READER_THEME_LABELS,
  READER_WIDTHS,
  READER_WIDTH_LABELS,
  stepReaderFontSize,
  type ReaderPreferences
} from '@shared/reader'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { viewportStore } from '@renderer/lib/formFactor'
import { POPOVER_WIDTH, toRect, useFrameDialog } from '@renderer/lib/portals'
import { closeReaderPreferences, readerPreferencesChanged, uiStore } from '@renderer/lib/ui'
import { useEscape } from '@renderer/hooks/useEscape'
import { V2IconButton } from '../extensions/v2'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import {
  ChoiceRow,
  DesktopPopover,
  ListRow,
  RowValue,
  TitleBlock
} from '../siteControls/primitives'
import { GLYPH } from '../security/glyph'

/** The chip in the address pill the popover hangs from, and where Escape hands the keyboard back. */
const CHIP = '[data-reader-prefs-chip]'
const TITLE_ID = 'reader-prefs-title'

type Panel = NonNullable<ReturnType<typeof uiStore.get>['readerPreferences']>

/**
 * Reader View's text preferences (CT-20; Chrome's Reading mode panel, Edge's Immersive Reader
 * "Text preferences"): the text size on its ladder with A− / A+, the font, the colour theme and
 * the column width, one setting for every reader page. On a mouse a 400 px popover under the
 * pill's chip (v2 draft §9.20) – rows with trailing controls (§9.21) under a title block (§9.23);
 * on a phone the shared bottom sheet with its 48 header (§9.16). Every change goes through
 * `reader.setPreferences`, which saves it and pushes it to the open reader pages; the page under
 * the surface is a picture, taken again after each change so the article is seen as it now
 * reads. The surface leaves by itself when its tab stops being a reader page or closes.
 */
export function ReaderPreferencesPanel({
  state,
  panel
}: {
  state: UIState
  panel: Panel
}): JSX.Element | null {
  const phone = viewportStore.use((s) => s.formFactor === 'phone')
  const tab = state.tabs[panel.tabId]
  const reader = Boolean(tab && tab.url.startsWith(READER_URL_PREFIX))
  const prefs = state.settings.reader
  // The page has taken the change (the state came back with it): its picture is taken again.
  const key = `${prefs.fontSize}|${prefs.font}|${prefs.theme}|${prefs.width}`
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    readerPreferencesChanged(panel.tabId)
  }, [key, panel.tabId])
  const change = useCallback((patch: Partial<ReaderPreferences>) => {
    run('reader.setPreferences', patch)
  }, [])
  // The tab was closed or left Reader View under the surface: the owner starts the exit.
  const closing = !reader
  const content = <Rows prefs={prefs} onChange={change} />
  return phone ? (
    <ReaderPreferencesSheet closing={closing}>{content}</ReaderPreferencesSheet>
  ) : (
    <ReaderPreferencesPopover anchor={panel.anchor} closing={closing}>
      {content}
    </ReaderPreferencesPopover>
  )
}

/**
 * The four settings, one composition on both platforms: the size as a stepper row – A− and A+
 * as the shared icon buttons (§9.3) with the size in px between them, the ends disabled at .4
 * (§9.30) – then a menulist row each for the font, the colour theme and the column width
 * (§9.13, a sheet of radio rows under a finger).
 */
function Rows({
  prefs,
  onChange
}: {
  prefs: ReaderPreferences
  onChange: (patch: Partial<ReaderPreferences>) => void
}): JSX.Element {
  const smallest = READER_FONT_SIZES[0]
  const largest = READER_FONT_SIZES[READER_FONT_SIZES.length - 1]
  return (
    <div className="flex flex-col" data-reader-prefs-rows="">
      <ListRow
        label="Text size"
        control
        data-reader-pref="fontSize"
        trailing={
          <span className="flex items-center gap-1">
            <V2IconButton
              icon={Minus}
              label="Smaller text"
              disabled={prefs.fontSize <= smallest}
              onClick={() => onChange({ fontSize: stepReaderFontSize(prefs.fontSize, -1) })}
            />
            <RowValue muted={false} className="min-w-[3ch] text-center tabular-nums">
              {prefs.fontSize}
            </RowValue>
            <V2IconButton
              icon={Plus}
              label="Larger text"
              disabled={prefs.fontSize >= largest}
              onClick={() => onChange({ fontSize: stepReaderFontSize(prefs.fontSize, 1) })}
            />
          </span>
        }
      />
      <ChoiceRow
        label="Font"
        value={prefs.font}
        options={READER_FONTS.map((value) => ({ value, label: READER_FONT_LABELS[value] }))}
        onChange={(font) => onChange({ font })}
      />
      <ChoiceRow
        label="Colour theme"
        description="Default follows Zenium’s colour scheme."
        value={prefs.theme}
        options={READER_THEMES.map((value) => ({ value, label: READER_THEME_LABELS[value] }))}
        onChange={(theme) => onChange({ theme })}
      />
      <ChoiceRow
        label="Column width"
        value={prefs.width}
        options={READER_WIDTHS.map((value) => ({ value, label: READER_WIDTH_LABELS[value] }))}
        onChange={(width) => onChange({ width })}
      />
    </div>
  )
}

/**
 * Desktop: the chassis popover (§9.20) 400 wide, its top border on the pill's bottom edge and
 * start-aligned with the chip, placed by `placePopover`; the panel shadow, no scrim (§9.5). It
 * renders through the chrome layer and the layer's light dismiss puts it away: a press
 * anywhere else closes it and reaches nothing beneath, the chip's own press closes it and keeps
 * the focus. Focus moves to the first control on open, Tab wraps, and Escape closes it and hands
 * the keyboard back to the chip (§9.22). Without a chip (the app menu with the pill hidden) it
 * hangs centred under the frame's top edge.
 */
function ReaderPreferencesPopover({
  anchor,
  closing,
  children
}: {
  anchor: Rect | null
  closing: boolean
  children: JSX.Element
}): JSX.Element {
  // The chip is measured as the popover opens, so a request from the menu finds it too.
  const [rects] = useState(() => {
    const chip = document.querySelector(CHIP)
    const pill = document.querySelector('.zen-pill')
    const chipRect = anchor ?? (chip ? toRect(chip.getBoundingClientRect()) : null)
    return {
      anchor: chipRect,
      bar: pill ? toRect(pill.getBoundingClientRect()) : chipRect
    }
  })
  return (
    <DesktopPopover
      anchor={rects.anchor}
      bar={rects.bar}
      width={POPOVER_WIDTH.form}
      labelledBy={TITLE_ID}
      closing={closing}
      anchorElement={() => document.querySelector<HTMLElement>(CHIP)}
      onClosed={(byKey) => closeReaderPreferences({ keepFocus: byKey })}
      data-reader-prefs-panel=""
      data-surface="page"
    >
      {() => (
        <>
          <TitleBlock
            id={TITLE_ID}
            glyph={<ALargeSmall className={GLYPH} />}
            title="Text preferences"
          />
          <div className="flex min-h-0 flex-col overflow-y-auto pb-1">{children}</div>
        </>
      )}
    </DesktopPopover>
  )
}

/**
 * Phone: the shared bottom sheet, hosted in TabDialogs' `FrameDialogHost` and drawing the
 * stack's one scrim itself (§9.28); the chassis's 48 header with the title centred (§9.16), the
 * rows edge to edge under it (§9.25). The system back gesture pulls it down with the finger;
 * the back button, Escape and a scrim tap slide it away. A menulist row opens the chassis's
 * picker sheet over it (§9.24).
 */
function ReaderPreferencesSheet({
  closing,
  children
}: {
  closing: boolean
  children: JSX.Element
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const dismiss = useCallback((): void => sheet.current?.dismiss(), [])
  useEffect(() => {
    if (closing) dismiss()
  }, [closing, dismiss])
  useBackSurface({
    name: 'reader-preferences',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(dismiss)
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  return (
    <BottomSheet
      ref={sheet}
      hosted
      onDismissed={() => closeReaderPreferences()}
      handleLabel="Resize text preferences"
      labelledBy={TITLE_ID}
      header={
        <h2 id={TITLE_ID} className="zen-sheet-title">
          Text preferences
        </h2>
      }
    >
      <div data-reader-prefs-panel="">{children}</div>
    </BottomSheet>
  )
}
