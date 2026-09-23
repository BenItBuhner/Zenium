import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ALargeSmall, AudioLines, Languages, Minus, Plus } from 'lucide-react'
import type { UIState } from '@shared/types'
import { languageName } from '@shared/languageNames'
import type { ReaderTranslateState, TranslateUIState } from '@shared/translate'
import { READER_URL_PREFIX } from '@shared/url'
import {
  READER_FONTS,
  READER_FONT_LABELS,
  READER_FONT_SIZES,
  READER_LINE_FOCUS,
  READER_LINE_FOCUS_LABELS,
  READER_SPACINGS,
  READER_SPACING_LABELS,
  READER_THEMES,
  READER_THEME_LABELS,
  READER_WIDTHS,
  READER_WIDTH_LABELS,
  stepReaderFontSize,
  type ReaderLineFocus,
  type ReaderPreferences
} from '@shared/reader'
import { anchorOf, type Anchor } from '@renderer/lib/anchor'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport, viewportStore } from '@renderer/lib/formFactor'
import {
  catalogueLanguageName,
  translateLanguageChoices
} from '@renderer/lib/languageCatalogue'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import {
  readerTranslateError,
  readerTranslateProgress,
  readerTranslateTarget,
  readerTranslateWorking
} from '@renderer/lib/readerTranslate'
import {
  closeReaderPreferences,
  readerPreferencesChanged,
  readerPreferencesChip,
  uiStore
} from '@renderer/lib/ui'
import { useEscape } from '@renderer/hooks/useEscape'
import { V2IconButton } from '../extensions/v2'
import { V2MenulistSheet } from '../extensions/V2Menulist'
import { MenulistPopover } from '../menus/MenulistPopover'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import {
  ChoiceRow,
  DesktopPopover,
  ListRow,
  RowValue,
  Separator,
  SwitchRow,
  TitleBlock
} from '../siteControls/primitives'
import { GLYPH } from '../security/glyph'

const TITLE_ID = 'reader-prefs-title'

type Panel = NonNullable<ReturnType<typeof uiStore.get>['readerPreferences']>

/** The focus band the switch turns on: the size last chosen this session, Edge's three lines before that. */
let lastLineFocus: ReaderLineFocus = 3

/**
 * Reader View's text preferences (CT-20, CT-13, EDGE-13; Chrome's Reading mode panel, Edge's
 * Immersive Reader "Text preferences" and "Reading preferences"): the one home for everything
 * the reader document offers (v2 §10.1 – the document itself draws no toolbar): read aloud's
 * start, the text size on its ladder with A− / A+, the font, the colour theme, the column
 * width and the text spacing, then the immersive-reader extras – line focus with its band size
 * and syllables – one setting for every reader page. On a mouse a 400 px popover under the
 * pill's chip (v2 draft §9.20) – rows with trailing controls (§9.21) under a title block (§9.23);
 * on a phone the shared bottom sheet with its 48 header (§9.16), a control panel that draws its
 * controls (§9.13). Every change goes through `reader.setPreferences`, which saves it and pushes
 * it to the open reader pages; the page under the surface is a picture, taken again after each
 * change so the article is seen as it now reads. The surface leaves by itself when its tab
 * stops being a reader page or closes.
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
  // Translate (CT-36) is a row here where the host runs the engine; the article's translation
  // is the tab's entry in the translate slice, none until it is asked for.
  const translate =
    state.capabilities.translate && state.translate.available ? state.translate : null
  const translation = translate?.reader?.[panel.tabId] ?? null
  // The page has taken the change (the state came back with it): its picture is taken again –
  // on a translation's turns too (its text swapped in, the original shown again), not on every
  // batch it finishes, which would take a picture per batch for nothing the still can show.
  const key = [
    prefs.fontSize,
    prefs.font,
    prefs.theme,
    prefs.width,
    prefs.spacing,
    prefs.lineFocus,
    prefs.syllables,
    translation?.status ?? '',
    translation?.target ?? '',
    translation?.showOriginal ?? ''
  ].join('|')
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
  // Read aloud's start (CT-13): the row ends the surface – the player docks under the page and
  // the article is what to look at – and the core reads the reader document from its top.
  const listen = state.capabilities.readAloud
    ? () => {
        closeReaderPreferences()
        run('readAloud.start', { tabId: panel.tabId, from: 'reader' })
      }
    : null
  const content = (
    <Rows
      prefs={prefs}
      onChange={change}
      onListen={listen}
      translate={translate && { tabId: panel.tabId, translate, translation }}
    />
  )
  return phone ? (
    <ReaderPreferencesSheet closing={closing}>{content}</ReaderPreferencesSheet>
  ) : (
    <ReaderPreferencesPopover panel={panel} closing={closing}>
      {content}
    </ReaderPreferencesPopover>
  )
}

/**
 * The rows, one composition on both platforms (§9.13's control panel): the panel's actions on
 * the article first, one group at its head – Listen to this article, an action row with the
 * read-aloud glyph, on hosts with a speech engine, and Translate (CT-36, `TranslateRow`) on
 * hosts with the translation engine, each a 44 action row with its 20 glyph (§10.4's mixing
 * rule holds within the group: the action rows carry glyphs together, the setting rows below
 * none) – then a hairline and the text: the size as a stepper row – A− and A+ as the shared
 * icon buttons (§9.3) with the size in px between them, the ends disabled at .4 (§9.30) – and
 * a menulist row each for the font, the colour theme, the column width and the spacing (§9.13,
 * a sheet of radio rows under a finger); then the extras: line focus as a switch row (§10.4)
 * with the band size a dependent menulist row – laid out at .4 while the focus is off – and
 * syllables as a switch row. #265's rule for the phone sheet holds with the one head row: the
 * peek shows the live type rows whole above the fold (the 44 head rows and the hairline before
 * Text spacing's bottom edge stay inside the 412 × 915 phone's peek), the set-once aids after
 * the hairline. Exported for the order's test.
 */
export function Rows({
  prefs,
  onChange,
  onListen,
  translate
}: {
  prefs: ReaderPreferences
  onChange: (patch: Partial<ReaderPreferences>) => void
  onListen: (() => void) | null
  translate: TranslateRowProps | null
}): JSX.Element {
  const smallest = READER_FONT_SIZES[0]
  const largest = READER_FONT_SIZES[READER_FONT_SIZES.length - 1]
  const focusOn = prefs.lineFocus !== 0
  return (
    <div className="flex flex-col" data-reader-prefs-rows="">
      {(onListen || translate) && (
        <>
          {onListen && (
            <ListRow
              label="Listen to this article"
              leading={<AudioLines className={GLYPH} aria-hidden />}
              onClick={onListen}
              data-reader-pref="listen"
            />
          )}
          {translate && <TranslateRow {...translate} />}
          <Separator />
        </>
      )}
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
        description="Default follows Zenium’s colour scheme"
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
      <ChoiceRow
        label="Text spacing"
        value={prefs.spacing}
        options={READER_SPACINGS.map((value) => ({ value, label: READER_SPACING_LABELS[value] }))}
        onChange={(spacing) => onChange({ spacing })}
      />
      <Separator />
      <SwitchRow
        label="Line focus"
        description="Dim everything but the lines being read"
        checked={focusOn}
        onChange={(on) => {
          if (!on) lastLineFocus = prefs.lineFocus
          onChange({ lineFocus: on ? lastLineFocus : 0 })
        }}
        data-reader-pref="lineFocus"
      />
      <ChoiceRow
        label="Lines in focus"
        value={String(focusOn ? prefs.lineFocus : lastLineFocus) as `${ReaderLineFocus}`}
        options={READER_LINE_FOCUS.filter((value) => value !== 0).map((value) => ({
          value: String(value) as `${ReaderLineFocus}`,
          label: READER_LINE_FOCUS_LABELS[value]
        }))}
        disabled={!focusOn}
        onChange={(value) => {
          const lineFocus = Number(value) as ReaderLineFocus
          lastLineFocus = lineFocus
          onChange({ lineFocus })
        }}
      />
      <SwitchRow
        label="Syllables"
        description="Mark the breaks between syllables"
        checked={prefs.syllables}
        onChange={(syllables) => onChange({ syllables })}
        data-reader-pref="syllables"
      />
    </div>
  )
}

interface TranslateRowProps {
  tabId: string
  translate: TranslateUIState
  /** The tab's reader translation, null until one is asked for. */
  translation: ReaderTranslateState | null
}

/** The picker's title and accessible name: what the pick chooses. */
const TARGET_LABEL = 'Translate into'

/** A language's name for the row: the runtime's, the catalogue's English where it has none – never the tag. */
const name = (code: string): string => catalogueLanguageName(code) ?? languageName(code)

/**
 * Translate (CT-36; Chrome's translate bubble folded into the reader's one panel – §9.13's
 * control panel draws its controls, so the article's translation is one row here rather than a
 * bar of its own, never a menulist-plus-action pair): Listen's sibling at the panel's head, a
 * 44 action row with the translate glyph. A press opens the target picker – the languages the
 * models reach as the chassis's menulist picker, a sheet of radio rows under a finger (opened
 * expanded and scrolled to the checked row when they exceed its peek, §9.13) and the popover
 * flush under the row on a mouse – with the remembered target checked and in view: the last
 * one picked here, else the translation's own, else the first preferred language a model
 * reaches (`readerTranslateTarget`; the article's own language, as the page translate detected
 * it, is never proposed). The pick translates: the core is asked to translate the reader
 * article in place into it (`translate.reader`), and the row is §9.30's busy row while the
 * core works – full opacity, the spinner trailing, its second line the progress (the language
 * being told, the model arriving with its bytes, the blocks done of the article's), a press
 * doing nothing. A failure keeps the row pressable with the reason as its second line in the
 * danger ink (§9.33: the ink on the line that reports it); the press opens the picker again,
 * the failed target checked, so the pick is the retry. Translated, the row becomes "Show
 * original", a switch row (§10.4, no glyph: a setting row) whose on state shows the article as
 * written with the translation kept (`translate.readerShowOriginal`), "Translated into
 * <language>" as its description. The panel's picture of the page follows each turn of the
 * translation, so the article is seen as it now reads.
 */
export function TranslateRow({ tabId, translate, translation }: TranslateRowProps): JSX.Element {
  const viewport = useViewport()
  const [chosen, setChosen] = useState<string | null>(null)
  // The picker is open from this anchor (the row's box; the phone's sheet needs none, but
  // takes the same mark).
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const options = translateLanguageChoices(translate.languages)
  // The page translate's detection stands in for the article's language until the reader's own
  // translation names it: the default target skips it (the core's `defaultTarget` rule).
  const pageSource = translate.tabs[tabId]?.source ?? null
  const target = readerTranslateTarget(translation, chosen, translate, pageSource)
  const working = readerTranslateWorking(translation)
  const pick = (code: string): void => {
    setAnchor(null)
    setChosen(code)
    run('translate.reader', { tabId, target: code })
  }
  if (translation?.status === 'translated') {
    return (
      <SwitchRow
        label="Show original"
        description={translation.target ? `Translated into ${name(translation.target)}` : undefined}
        checked={translation.showOriginal}
        onChange={(original) => run('translate.readerShowOriginal', { tabId, original })}
        data-reader-pref="showOriginal"
      />
    )
  }
  let description: ReactNode
  if (translation && working) description = readerTranslateProgress(translation)
  else if (translation?.status === 'error') {
    description = (
      <span className="zen-settings-danger">{readerTranslateError(translation.error)}</span>
    )
  }
  return (
    <>
      <ListRow
        label="Translate"
        description={description}
        leading={<Languages className={GLYPH} aria-hidden />}
        busy={working}
        disabled={target === null}
        aria-haspopup={viewport.coarse ? 'dialog' : 'listbox'}
        aria-expanded={anchor !== null}
        onClick={(e) => setAnchor(anchorOf(e.currentTarget))}
        data-reader-pref="translate"
      />
      {anchor &&
        (viewport.coarse ? (
          <V2MenulistSheet
            label={TARGET_LABEL}
            value={target ?? ''}
            options={options}
            onPick={pick}
            onClose={() => setAnchor(null)}
          />
        ) : (
          <MenulistPopover
            anchor={anchor}
            label={TARGET_LABEL}
            value={target}
            options={options}
            onPick={pick}
            onClose={() => setAnchor(null)}
            overPage
          />
        ))}
    </>
  )
}

/**
 * Desktop: the chassis popover (§9.20) 400 wide, hanging from the pill's Text preferences chip
 * – its top border on the pill's bottom edge and start-aligned with the chip, which keeps its
 * pressed fill meanwhile – whether the chip or the app menu's "Text Preferences…" asked for it
 * (`lib/ui.ts`'s `openReaderPreferences`; the reader tab never hides the chip, §9.29), placed
 * by `placePopover`; the panel shadow, no scrim (§9.5). It renders through the chrome layer
 * and the layer's light dismiss puts it away: a press anywhere else closes it and reaches
 * nothing beneath, the chip's own press closes it and keeps the focus. Focus moves to the
 * first control on open, Tab wraps, and Escape closes it and hands the keyboard back to the
 * chip (§9.22). With no chip on screen (compact mode) it hangs under the frame's top edge.
 */
function ReaderPreferencesPopover({
  panel,
  closing,
  children
}: {
  panel: Panel
  closing: boolean
  children: JSX.Element
}): JSX.Element {
  return (
    <DesktopPopover
      anchor={panel.anchor}
      bar={panel.bar ?? panel.anchor}
      width={POPOVER_WIDTH.form}
      labelledBy={TITLE_ID}
      closing={closing}
      anchorElement={readerPreferencesChip}
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
      <div data-reader-prefs-panel="" className="pb-2">
        {children}
      </div>
    </BottomSheet>
  )
}
