import type { JSX, RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ArrowUpLeft, Camera, Globe, Link, Mic, Pencil, Share2, X } from 'lucide-react'
import type {
  ClipboardContent,
  PhoneBarLayout,
  PhoneBarPosition,
  Rect,
  SearchEngine,
  Suggestion,
  Tab,
  UIState
} from '@shared/types'
import {
  BAR_BUTTON,
  BAR_GAP,
  BAR_PADDING,
  phoneBarForHost,
  phoneBarOffered
} from '@shared/phoneBar'
import {
  SEARCH_SCOPES,
  buildSearchUrl,
  completeWwwCom,
  defaultSearchEngineOf,
  matchEngineWord,
  matchKeyword
} from '@shared/search'
import { internalPageAliasUrl } from '@shared/internalPages'
import { ERROR_URL_PREFIX, displayUrl, isEmptyTabUrl, isNewTabUrl } from '@shared/url'
import { qrScanAvailable } from '@shared/qrScan'
import { voiceSearchAvailable } from '@shared/voice'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { useOmniboxFocusBinding } from '@renderer/hooks/useOmniboxFocusBinding'
import { cmd, run } from '@renderer/lib/api'
import { useBackDismissal } from '@renderer/lib/back'
import { dropStore } from '@renderer/lib/drag'
import { fakeboxBackPulled, fakeboxTakesCommit } from '@renderer/lib/fakeboxMorph'
import { focusBackPulled, focusTakesCommit } from '@renderer/lib/omniboxFocus'
import { viewportStore } from '@renderer/lib/formFactor'
import { urlbarFieldBox } from '@renderer/lib/layout'
import {
  URLBAR_KEYBOARD_EVENT,
  URLBAR_LEAVE_EVENT,
  toolbarControlBesideAddress
} from '@renderer/lib/panes'
import { startQrScan } from '@renderer/lib/qrScan'
import { activeTab, isEmptySplitPane } from '@renderer/lib/selectors'
import { closeUrlbar, uiStore, type UrlbarState } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { startVoiceSearch } from '@renderer/lib/voiceSearch'
import { useLongPress } from '../phone/useLongPress'
import { V2_GLYPH } from '../v2/controls'
import { Highlighted } from '../v2/Highlighted'
import { EngineFieldGlyph } from './EngineFieldGlyph'
import { matchRanges } from './highlight'
import { isShareableUrl, showsPageHeader } from './omniboxHeader'
import {
  ghostBox,
  headingKey,
  headingLeavesWith,
  listOffsets,
  moverDeltas,
  runRowExit,
  withoutExit,
  type GhostBox,
  type RowExit
} from './rowExit'
import {
  arrowStep,
  clickTarget,
  escapeIntent,
  pageStep,
  selectionAfterRemoval,
  submitTarget,
  tabStep,
  type OpenWhere
} from './omniboxKeys'
import { PillChip } from './PillChip'
import { RemoveSuggestionSheet } from './RemoveSuggestionSheet'
import { suggestionIcon } from './suggestionIcon'

interface Props {
  state: UIState
  urlbar: UrlbarState
  /** Content area the bar floats in (desktop layouts); null for the phone sheet. */
  area: Rect | null
  /**
   * Phone layout: the edge the address bar is docked at. The field takes the bar's own band and
   * the suggestions fill the content frame, growing away from it towards the middle of the screen.
   */
  phoneEdge?: PhoneBarPosition
  /**
   * Tablet layout: the toolbar's address pill, in the coordinates of the layer the bar is drawn
   * in. The bar is then the pill's popup (TB-21): attached, hung `POPUP_GAP` under it and as
   * wide as it, growing down over the page as far as `area` (the shell's box) lets it.
   */
  anchor?: Rect | null
}

/**
 * The gap between the tablet pill and its popup (v2 §9.36: Zen's floating bar under the pill,
 * as the design gate's stills showed it): 4 px of the toolbar's own bottom padding, so the popup
 * reads as hung from the pill rather than fused to it, while it still meets no other edge.
 */
const POPUP_GAP = 4

/**
 * Zen remembers what you typed until you navigate away: the desktop bar's per-tab draft, kept
 * through Escape, an outside press or the back gesture and restored, selected, on the next open
 * over the same page. On the PHONE a dismissed bar discards the draft instead, as Chrome for
 * Android does (a program default of 19 Sep 2026): the pill opens search-ready every time, with
 * the header (OMN-05) and the clipboard row (OMN-14), which a restored draft would hide until it
 * is cleared. Nothing is written or read here for the phone; a submit, Edit and the header chips
 * are as they are on either.
 */
const drafts = new Map<string, string>()
let keywordSeq = 0

/**
 * The text the field holds for a page: its address, the address an error page stands in for, or
 * an internal page's user-facing `zenium://` alias (`zen://` never shows; v2 §10.1). Empty tabs –
 * blank and the new tab page alike – hold nothing, as Chrome's omnibox does there.
 */
function pageTextFor(tab: Tab): string {
  if (isEmptyTabUrl(tab.url)) return ''
  if (tab.url.startsWith(ERROR_URL_PREFIX)) {
    try {
      return new URL(tab.url).searchParams.get('url') ?? ''
    } catch {
      return ''
    }
  }
  return internalPageAliasUrl(tab.url)
}

/**
 * The text the field holds at rest over a page: its address on desktop (selected, so typing
 * replaces it); nothing on the phone, where the bar opens search-ready (Chrome for Android) and
 * the page's address sits in the header row above the suggestions, put into the field by Edit.
 */
function restTextFor(tab: Tab, phone: boolean): string {
  return phone ? '' : pageTextFor(tab)
}

function initialTextFor(state: UIState, urlbar: UrlbarState, phone: boolean): string {
  if (urlbar.initialText !== undefined) return urlbar.initialText
  // The phone restores no draft (see `drafts`), not even one a desktop layout left behind.
  if (urlbar.mode !== 'edit' || !urlbar.tabId) return (phone ? undefined : drafts.get('new')) ?? ''
  const tab = state.tabs[urlbar.tabId]
  if (!tab) return ''
  const draft = phone ? undefined : drafts.get(`${tab.id}|${tab.url}`)
  if (draft !== undefined) return draft
  return restTextFor(tab, phone)
}

/** The completion tail is selected: the caret's selection runs from inside the text to its end. */
function hasCompletionTail(el: HTMLInputElement): boolean {
  return (
    el.selectionStart !== null &&
    el.selectionEnd !== null &&
    el.selectionStart < el.selectionEnd &&
    el.selectionEnd === el.value.length
  )
}

/**
 * Keyword mode held as state (tab-to-search, Ctrl+K, `?`; omnibox-08, -26): the engine the
 * field searches with, and the text Backspace on the empty field brings back – the keyword or
 * name the user typed (`@ddg`, `youtube`), `?`, or nothing for the Ctrl+K search mode.
 */
interface KeywordMode {
  engine: SearchEngine
  typed: string
}

/** The id of a row's trailing control, the target Tab moves the keyboard to (omnibox-50). */
const rowActionId = (row: number, action: number): string =>
  `zen-omnibox-row-${row}-action-${action}`

/** A row the user can remove (the X, Shift+Delete): the core says so (`deletable`). */
const removable = (row: Suggestion): boolean => Boolean(row.deletable)

/** The list item carrying `attr="value"` (matched as text: ids and labels are not selectors). */
function childBy(list: HTMLElement, attr: string, value: string): HTMLElement | null {
  for (const el of list.children)
    if (el instanceof HTMLElement && el.getAttribute(attr) === value) return el
  return null
}

/** Rows that come from the user's own typing or pages, worth remembering as shortcuts. */
const LEARNABLE_KINDS = new Set<Suggestion['kind']>(['url', 'history', 'search', 'entity'])

export function Urlbar({ state, urlbar, area, phoneEdge, anchor }: Props): JSX.Element {
  const phone = Boolean(phoneEdge)
  const [text, setText] = useState(() => initialTextFor(state, urlbar, phone))
  const [results, setResults] = useState<Suggestion[]>([])
  /**
   * The clipboard row's content once the user revealed it (Chrome's "Link you copied" shows the
   * kind alone until the Show tap); read once, and reused when the row is then picked.
   */
  const [clip, setClip] = useState<ClipboardContent | null>(null)
  const [selected, setSelected] = useState(-1)
  /**
   * The highlighted row's control the keyboard is on (`-1`: the field itself; `0…`: the row's
   * trailing controls, Tab moves through them) – omnibox-50's row-action cycling.
   */
  const [action, setAction] = useState(-1)
  /** Escape's first stage (omnibox-50): the rows are put away, the typed text kept. */
  const [popupClosed, setPopupClosed] = useState(false)
  /**
   * A row of the phone card on its way out (OMN-17): still in `results` while its exit runs,
   * drawn as a ghost where it stood, and spliced out at rest (`rowExit.ts`).
   */
  const [exit, setExit] = useState<RowExit | null>(null)
  /** The row a hold is asking about (OMN-17): its prompt sheet is up while this is set. */
  const [asking, setAsking] = useState<Suggestion | null>(null)
  /** The list the exit runs in, and where its items stood before the ghosts left the flow. */
  const exitList = useRef<{ list: HTMLElement; before: Map<HTMLElement, number> } | null>(null)
  const exitStop = useRef<(() => void) | null>(null)
  /** The rows as last set, for callbacks that run after their render (a sheet's answer). */
  const resultsRef = useRef(results)
  useLayoutEffect(() => {
    resultsRef.current = results
  }, [results])
  const inputRef = useRef<HTMLInputElement>(null)
  const fadeResults = useFadeEdges<HTMLUListElement>({ axis: 'y' })
  const requestSeq = useRef(0)
  /** What the user typed, without any inline completion the field shows after it. */
  const lastTyped = useRef(text)
  /**
   * The same, as state, for the row pick and the submit (the shortcuts provider learns what
   * was typed, omnibox-03): the row callbacks stay clear of the field's refs.
   */
  const [typedText, setTypedText] = useState(text)
  const rememberTyped = (value: string): void => {
    lastTyped.current = value
    setTypedText(value)
  }
  /** An IME composition is under way: nothing is completed inline until it is committed. */
  const composing = useRef(false)
  const engines = state.searchEngines
  const defaultEngine = defaultSearchEngineOf(
    engines,
    state.settings.searchEngineId,
    state.searchEngineControl
  )
  const tab = urlbar.tabId ? state.tabs[urlbar.tabId] : null
  // Ctrl+K / Ctrl+E open the bar in search mode: keyword mode for the default engine, the chip
  // up from the start and nothing to bring back on Backspace (Chrome's).
  const [keywordMode, setKeywordMode] = useState<KeywordMode | null>(() =>
    urlbar.mode === 'search' ? { engine: defaultEngine, typed: '' } : null
  )

  // Keyword mode from the text (`@ddg cats`, `@bookmarks foo`): the chip names where the search
  // goes. The state's keyword mode (above) takes precedence: the field then holds the terms alone.
  const textKeyword = useMemo(
    () => (keywordMode ? null : matchKeyword(text.trimStart(), engines)),
    [keywordMode, text, engines]
  )
  const engine =
    keywordMode?.engine ?? (textKeyword?.kind === 'engine' ? textKeyword.engine : defaultEngine)
  const scopeLabel =
    textKeyword?.kind === 'scope'
      ? (SEARCH_SCOPES.find((s) => s.scope === textKeyword.scope)?.label ?? textKeyword.scope)
      : null
  // The scope labels already read "Search bookmarks" / "Search history" / "Search tabs".
  const chipLabel = keywordMode
    ? `Search ${keywordMode.engine.name}`
    : textKeyword
      ? textKeyword.kind === 'engine'
        ? `Search ${textKeyword.engine.name}`
        : scopeLabel
      : null
  const inKeyword = keywordMode !== null || textKeyword !== null

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (urlbar.typed) {
      // Text the user typed into the new tab page before the bar was up: carry on after it.
      el.setSelectionRange(el.value.length, el.value.length)
      return
    }
    // Everything selected, read from the start: `select()` alone puts the caret end at the tail
    // and scrolls a long URL so only its query is visible. A backward selection keeps the focus
    // end – the one the field scrolls to – at the origin.
    el.setSelectionRange(0, el.value.length, 'backward')
    el.scrollLeft = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on mount
  }, [])

  // The state's keyword mode, readable from the fetch callback without re-creating it per change
  // (`enterKeywordMode` writes it ahead of the state, so its own fetch already sees the engine).
  const modeRef = useRef(keywordMode)
  useLayoutEffect(() => {
    modeRef.current = keywordMode
  }, [keywordMode])

  const fetchSuggestions = useCallback(
    async (query: string, autofill: boolean, engine?: SearchEngine | null) => {
      const seq = ++requestSeq.current
      // The engine the rows are for: the one given (entering or leaving keyword mode, ahead of
      // the state), else the keyword mode's.
      const engineId = engine === undefined ? modeRef.current?.engine.id : engine?.id
      const list = await cmd('urlbar.suggest', {
        query,
        tabId: urlbar.tabId,
        ...(engineId ? { engineId } : {}),
        // The phone's card is sectioned under headings (OMN-18); the desktop popup is flat.
        ...(phone ? { grouped: true } : {})
      }).catch(() => [] as Suggestion[])
      if (seq !== requestSeq.current) return
      // A fresh list is laid out whole: an exit in flight has nothing left to leave from.
      exitStop.current?.()
      exitStop.current = null
      setExit(null)
      setResults(list)
      setPopupClosed(false)
      setAction(-1)
      // A fresh list may carry a fresh clipboard row: what was revealed is not vouched for.
      setClip(null)
      const first = list[0]
      const el = inputRef.current
      // Inline completion of the default match (Chrome's rule, decided in the core: the top row
      // outranks the verbatim query and extends what was typed): what was typed stays as typed,
      // the remainder is appended selected, so typing on replaces it and Backspace removes it.
      // Only while the field still shows the text the request was for, with the caret at its
      // end and no IME composition under way.
      if (
        autofill &&
        first?.inline &&
        el &&
        !composing.current &&
        el.value === query &&
        el.selectionStart === query.length &&
        el.selectionEnd === query.length &&
        first.fill.length > query.length &&
        first.fill.toLowerCase().startsWith(query.toLowerCase())
      ) {
        const fill = query + first.fill.slice(query.length)
        el.value = fill
        setText(fill)
        el.setSelectionRange(query.length, fill.length)
        setSelected(0)
      } else {
        setSelected(-1)
      }
    },
    [urlbar.tabId, phone]
  )

  useEffect(() => {
    // Typed text behaves as if typed here: inline completion applies to it from the start.
    const autofill = Boolean(urlbar.typed) && !/\s/.test(lastTyped.current)
    const timer = setTimeout(() => void fetchSuggestions(lastTyped.current, autofill), 0)
    return () => clearTimeout(timer)
  }, [fetchSuggestions, urlbar.typed])

  // Keys the new tab page's search box received while this bar was already open (a keystroke
  // that raced the focus hand-off): spliced in at the caret as if typed here.
  useEffect(() => {
    const onType = (e: Event): void => {
      const el = inputRef.current
      const typed = (e as CustomEvent<string>).detail
      if (!el || !typed) return
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? el.value.length
      const value = el.value.slice(0, start) + typed + el.value.slice(end)
      el.value = value
      el.setSelectionRange(start + typed.length, start + typed.length)
      el.focus()
      const grew = value.length > lastTyped.current.length && value.startsWith(lastTyped.current)
      rememberTyped(value)
      setText(value)
      void fetchSuggestions(value, grew && !/\s/.test(value))
    }
    window.addEventListener('zen-urlbar-type', onType)
    return () => window.removeEventListener('zen-urlbar-type', onType)
  }, [fetchSuggestions])

  /** Put `value` in the field with the caret at its end, as the text the user now "typed". */
  const setTyped = (value: string, refetch: boolean): void => {
    rememberTyped(value)
    setText(value)
    const el = inputRef.current
    if (el) {
      el.value = value
      el.setSelectionRange(value.length, value.length)
    }
    if (refetch) void fetchSuggestions(value, false)
  }

  /**
   * Into keyword mode for `engine` (tab-to-search, omnibox-08): the chip comes up, the field
   * holds `rest` alone (what was typed after the keyword, usually nothing) and `typed` is what
   * Backspace on the empty field brings back. The rows are the engine's from here on.
   */
  const enterKeywordMode = (engine: SearchEngine, typed: string, rest = ''): void => {
    setKeywordMode({ engine, typed })
    setSelected(-1)
    setAction(-1)
    rememberTyped(rest)
    setText(rest)
    void fetchSuggestions(rest, false, engine)
  }

  /**
   * Out of keyword mode: Backspace on the empty field and Escape bring the typed keyword back
   * (`@ddg`, the engine's name, `?`); the Ctrl+K search mode has none, so the terms stay.
   */
  const exitKeywordMode = (): void => {
    const mode = keywordMode
    if (!mode) return
    setKeywordMode(null)
    setSelected(-1)
    setAction(-1)
    const value = mode.typed || text
    setTyped(value, false)
    void fetchSuggestions(value, false, null)
  }

  const onChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = e.target.value
    // Chrome's legacy `?` prefix: typed first, it is search mode for the default engine; what
    // follows is the query, however much it looks like an address (omnibox-26).
    if (!keywordMode && !phone && value.startsWith('?') && !lastTyped.current.startsWith('?')) {
      enterKeywordMode(defaultEngine, '?', value.slice(1).trimStart())
      return
    }
    // An engine's keyword or host followed by Space enters keyword mode for it (Tab does the
    // same, and takes the engine's name too, in `onKeyDown`); `@bookmarks ` and the other
    // scopes stay text, as today.
    if (!keywordMode && !phone && /\s$/.test(value) && !/\s/.test(value.trimStart().slice(0, -1))) {
      const word = value.trim()
      const engine = word ? matchEngineWord(word, engines) : null
      if (engine) {
        enterKeywordMode(engine, word)
        return
      }
    }
    const grew = value.length > lastTyped.current.length && value.startsWith(lastTyped.current)
    const caretAtEnd = e.target.selectionStart === value.length
    rememberTyped(value)
    setText(value)
    setSelected(-1)
    setAction(-1)
    setPopupClosed(false)
    // A deletion, an edit in the middle or a composition in progress never re-inlines.
    const native = e.nativeEvent as Event & { isComposing?: boolean }
    void fetchSuggestions(value, grew && caretAtEnd && !composing.current && !native.isComposing)
  }

  const clear = (): void => {
    setTyped('', true)
    inputRef.current?.focus()
  }

  // A picked scope row (`@b` → `@bookmarks `) becomes the typed text once the pick has rendered,
  // and a picked engine row's keyword mode (its state set at the pick) gets its rows: the row's
  // click handler itself stays clear of the field's refs, this effect works them.
  const [keywordFill, setKeywordFill] = useState<{
    fill: string
    engine?: SearchEngine
    seq: number
  } | null>(null)
  useEffect(() => {
    if (!keywordFill) return
    const { fill, engine } = keywordFill
    lastTyped.current = fill
    const el = inputRef.current
    if (el) {
      el.value = fill
      el.setSelectionRange(fill.length, fill.length)
    }
    void fetchSuggestions(fill, false, engine)
  }, [keywordFill, fetchSuggestions])

  // The caret to the field's end once a highlight has put a row's text in it (`highlight`, which
  // the row callbacks reach and so stays clear of the field's refs).
  const [caretSeq, setCaretSeq] = useState(0)
  useLayoutEffect(() => {
    if (caretSeq === 0) return
    const el = inputRef.current
    el?.setSelectionRange(el.value.length, el.value.length)
  }, [caretSeq])

  // The keyboard follows the highlight's action (omnibox-50): onto the row's control when Tab
  // reaches one, back into the field when it leaves it – the field keeps its caret at the end.
  const lastAction = useRef(-1)
  useEffect(() => {
    const was = lastAction.current
    lastAction.current = action
    if (action >= 0) {
      document.getElementById(rowActionId(selected, action))?.focus()
    } else if (was >= 0) {
      const el = inputRef.current
      el?.focus()
      el?.setSelectionRange(el.value.length, el.value.length)
    }
  }, [action, selected])

  // A new-tab draft is shared by every new tab page, as it is for the bar without a tab.
  const draftKey = tab && urlbar.mode !== 'new-tab' ? `${tab.id}|${tab.url}` : 'new'
  // `keepDraft` is the desktop's: the phone discards what was typed on every dismissal (see
  // `drafts`), so the system back, the scrim and the pill's close all reopen it search-ready.
  const close = useCallback(
    (keepDraft: boolean, keepKeyboard = false) => {
      if (keepDraft && !phone && text.trim() && (!tab || text !== pageTextFor(tab))) {
        drafts.set(draftKey, text)
      } else drafts.delete(draftKey)
      // An extension's omnibox session, if one was on, ends without an entry.
      run('urlbar.cancel', undefined)
      // A dismissal, not a submit: the new tab page's field morph runs back on it (lib/fakeboxMorph.ts).
      closeUrlbar({ keepKeyboard, reason: 'dismiss' })
    },
    [draftKey, phone, tab, text]
  )
  // F6 / Shift+F6 from the bar (lib/panes.ts): the keyboard has moved on to another chrome pane;
  // the bar goes away as on Escape – draft kept, extension session ended – and leaves it there.
  useEffect(() => {
    const onLeave = (): void => close(true, true)
    window.addEventListener(URLBAR_LEAVE_EVENT, onLeave)
    return () => window.removeEventListener(URLBAR_LEAVE_EVENT, onLeave)
  }, [close])

  // The empty pane's bar (split-04) is the pane's field and goes with the pane: its blank tab
  // navigated or left the split, or a pane the user pressed in took the active state (split-06)
  // – the frame-wide bar would have taken that press itself.
  const paneLive =
    !urlbar.pane || (isEmptySplitPane(state, urlbar.tabId) && activeTab(state)?.id === urlbar.tabId)
  useEffect(() => {
    if (!paneLive) close(true)
  }, [paneLive, close])

  // The system back gesture lifts the bar away like a sheet off the top edge, fading as it goes;
  // commit closes it keeping the draft, like Escape, cancel springs it back. On the phone the
  // suggestions sheet shrinks towards the bar's edge and the field settles back into the pill.
  const panelRef = useRef<HTMLDivElement>(null)

  // The empty pane's bar lets presses through to the chrome around it (its frame is
  // `pointer-events: none` below), so a press outside the panel is heard here instead: the bar
  // closes, draft kept, and the press goes on to what it landed on – the pane's "Choose a tab"
  // button opens the picker with that same press.
  useEffect(() => {
    if (!urlbar.pane) return
    const onPress = (e: PointerEvent): void => {
      const panel = panelRef.current
      if (panel && e.target instanceof Node && panel.contains(e.target)) return
      close(true)
    }
    document.addEventListener('pointerdown', onPress, true)
    return () => document.removeEventListener('pointerdown', onPress, true)
  }, [urlbar.pane, close])

  // A page's view took the keyboard while the bar is up (lib/panes.ts `pageTookKeyboard`): the
  // new tab's own page as it is shown, racing the bar's mount – on a slow machine after the
  // field's focus, which left the bar with no caret. The chrome's keyboard is asked back and
  // the field focused, so the caret is there whichever came first; the keyboard already on
  // another control of the bar (a row's X, reached with Tab) is left there. The phone's host
  // never reports a page taking the keyboard (its page view is the system's).
  useEffect(() => {
    const onKeyboard = (): void => {
      run('focus.chrome', undefined)
      const el = inputRef.current
      const active = document.activeElement
      if (!el || (active !== document.body && panelRef.current?.contains(active))) return
      el.focus()
    }
    window.addEventListener(URLBAR_KEYBOARD_EVENT, onKeyboard)
    return () => window.removeEventListener(URLBAR_KEYBOARD_EVENT, onKeyboard)
  }, [])
  const sheetRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLDivElement>(null)
  useBackDismissal('urlbar', {
    travel: 320,
    render: (v) => {
      // The bar the new tab page's field morphed into: the gesture pulls the field back toward
      // the page instead, and the sheet fades on the morph's value (lib/fakeboxMorph.ts). The
      // bar the pill grew into: the field shrinks back toward the pill and the bar's buttons
      // come back with the finger, on the focus value (lib/omniboxFocus.ts).
      if (fakeboxBackPulled(v) || focusBackPulled(v)) return
      const sheet = sheetRef.current
      if (sheet) {
        sheet.style.transform = `scale(${1 - 0.08 * v})`
        sheet.style.opacity = String(1 - 0.6 * v)
        const field = fieldRef.current
        if (field) field.style.opacity = String(1 - 0.5 * v)
        return
      }
      const el = panelRef.current
      if (!el) return
      el.style.transformOrigin = '50% 0%'
      el.style.transform = `translateY(${-100 * v}%) scale(${1 - 0.06 * v})`
      el.style.opacity = String(1 - 0.7 * v)
    },
    // The bar the field morphed into, or the pill grew into: a commit the field has not followed
    // – mid-flight, or a back key with nothing pulled – dismisses on the motion's own closing
    // segment from where the field is (the close hook starts it), not at the end of the bar's
    // spring, which the field would meet in a jump. After a pull the bar's spring finishes the
    // way home: the field follows it (`fakeboxBackPulled` / `focusBackPulled`) and the close
    // comes at once when it lands.
    committed: (value) => {
      if (!fakeboxTakesCommit(value) && !focusTakesCommit(value)) return false
      close(true)
      return true
    },
    dismissed: () => close(true)
  })

  /**
   * Whether a plain submit opens a new tab: without a tab, or in new-tab mode – except over a new
   * tab page, which the bar edits (what is typed loads there, no second tab).
   */
  const submitsToNewTab = (): boolean => {
    const overNewTabPage = urlbar.mode === 'new-tab' && Boolean(tab && isNewTabUrl(tab.url))
    return !tab || (urlbar.mode === 'new-tab' && !overNewTabPage)
  }

  /**
   * Open `item` (or the field's text) where `where` says (omnibox-24, -25): this tab, a new
   * foreground tab, a background tab, a new window. In keyword mode the verbatim text is the
   * engine's search. What the user typed goes along for the shortcuts provider (omnibox-03) –
   * a page or a search they chose for it is boosted the next time they type it.
   */
  const submit = (
    item: Suggestion | null,
    opts: { where?: OpenWhere; input?: string } = {}
  ): void => {
    const where = opts.where ?? 'current'
    const value = (opts.input ?? text).trim()
    const newTab = where === 'tab' || where === 'background' || submitsToNewTab()
    const typed = typedText.trim()
    const navigate = (
      input: string,
      learn?: { title: string; kind?: 'url' | 'search' } | null
    ): void =>
      run('urlbar.submit', {
        input,
        newTab: where === 'window' ? false : newTab,
        tabId: tab?.id ?? null,
        background: where === 'background',
        newWindow: where === 'window',
        ...(learn && typed ? { learn: { typed, ...learn } } : {})
      })
    if (item) {
      switch (item.kind) {
        case 'tab':
          if (item.targetId) run('tab.activate', { tabId: item.targetId })
          break
        case 'space':
          if (item.targetId) run('space.activate', { spaceId: item.targetId })
          break
        case 'command':
          if (item.targetId) run('urlbar.runCommand', { action: item.targetId })
          break
        case 'engine': {
          // A keyword to complete: an engine's row enters keyword mode for it (the chip up, the
          // field emptied); a scope's (`@b` → `@bookmarks `) becomes the typed text. The bar
          // stays open either way.
          const picked = engines.find((e) => e.id === item.targetId)
          if (picked) {
            // As `enterKeywordMode`, the state here and the field's refs in the effect.
            setKeywordMode({ engine: picked, typed: item.title })
            setSelected(-1)
            setAction(-1)
            setText('')
            setTypedText('')
            setKeywordFill({ fill: '', engine: picked, seq: ++keywordSeq })
            return
          }
          setText(item.fill)
          setTypedText(item.fill)
          setKeywordFill({ fill: item.fill, seq: ++keywordSeq })
          return
        }
        case 'omnibox':
          // The keyword-prefixed text goes back whole: the extension takes it from there.
          navigate(item.fill)
          break
        case 'bookmark':
          // Through the bookmark so its "last used" date is recorded.
          if (item.targetId && where !== 'background' && where !== 'window') {
            run('bookmark.open', { id: item.targetId, newTab, tabId: tab?.id ?? null })
            break
          }
          if (item.url) navigate(item.url)
          break
        case 'search':
          // `@bookmarks foo` / `@history foo`: the typed text carries the scope the core acts on.
          if (item.id === 'scope') navigate(value)
          else if (item.url) navigate(item.url, { title: item.title, kind: 'search' })
          break
        default:
          if (item.url)
            navigate(
              item.url,
              LEARNABLE_KINDS.has(item.kind) ? { title: item.title, kind: 'url' } : null
            )
      }
    } else {
      if (!value) return
      if (keywordMode) {
        // The terms alone are in the field: the engine's search, learned as one for the default
        // engine's search mode (`?`, Ctrl+K), not for an explicit keyword.
        const isDefault = keywordMode.engine.id === defaultEngine.id
        navigate(
          buildSearchUrl(keywordMode.engine, value),
          isDefault ? { title: value, kind: 'search' } : null
        )
      } else navigate(value, { title: value })
    }
    drafts.delete(draftKey)
    drafts.delete('new')
    closeUrlbar()
  }

  /**
   * The clipboard row's content, read ONCE: on the Show tap (the row then shows it) or on the
   * pick when it was not shown. Android 12+ may toast the read; the peek that put the row up read
   * the clip's description only. A clip gone or changed meanwhile takes the row away.
   */
  const readClip = async (): Promise<ClipboardContent | null> => {
    if (clip) return clip
    const content = await cmd('clipboard.read', undefined).catch(() => null)
    if (!content || content.kind === 'none') {
      setResults((r) => r.filter((row) => row.kind !== 'clipboard'))
      return null
    }
    setClip(content)
    return content
  }
  const revealClip = (): void => {
    void readClip()
    inputRef.current?.focus()
  }
  /**
   * Tapping the row: a link opens, text is searched for with the default engine. The pick is
   * what uses the clip up: the host remembers it and does not offer it again until the
   * clipboard changes (a reveal alone does not, as in Chrome).
   */
  const pickClip = async (): Promise<void> => {
    const content = await readClip()
    if (!content) return
    run('clipboard.markUsed', undefined)
    submit(null, {
      input: content.kind === 'url' ? content.text : buildSearchUrl(defaultEngine, content.text)
    })
  }

  // The search-ready header's chips (OMN-05). Share hands the page to the system sheet and lets
  // the bar go; Copy link and Edit keep the field focused, the keyboard where it is. Share is
  // for http(s) pages only (Chrome disables it on schemes another app cannot open; a
  // `zenium://settings` address means nothing to the sheet's targets), Copy link and Edit stay.
  const pageHeader = showsPageHeader(phone, urlbar.mode, tab, text) ? tab : null
  const sharePage = (): void => {
    if (!tab) return
    close(false)
    run('app.share', {
      title: tab.customTitle ?? tab.title,
      url: internalPageAliasUrl(tab.url),
      tabId: tab.id,
      favicon: tab.favicon ?? undefined
    })
  }
  const copyPageLink = (): void => {
    if (!tab) return
    run('tab.copyUrl', { tabId: tab.id })
    // The clipboard is the page's address now; a revealed clip no longer says what it holds.
    setClip(null)
  }
  const editPageUrl = (): void => {
    if (tab) setTyped(pageTextFor(tab), true)
  }

  /** A query row whose Refine arrow would change the field (never the verbatim "what you typed"). */
  const refinable = (item: Suggestion): boolean =>
    item.kind === 'search' && item.fill.trim() !== text.trim()
  /** Refine (OMN-09): the row's text into the field as typed, suggestions refreshed, no submit. */
  const refine = (item: Suggestion): void => setTyped(item.fill, true)

  /**
   * Forget a removable row where it came from: a history row and its entry (`history.delete`,
   * the one the history page's rows run), a remembered search or destination, an omnibox row
   * its extension marked deletable.
   */
  const forget = (row: Suggestion): boolean => {
    if (!removable(row)) return false
    if (row.kind === 'history' && row.url) run('history.delete', { url: row.url })
    else if (row.kind === 'omnibox') run('urlbar.deleteSuggestion', { input: row.fill })
    else if (row.url) run('urlbar.forgetShortcut', { url: row.url })
    else return false
    return true
  }

  /**
   * Remove row `index` (Shift+Delete, the X; omnibox-22): a history row and its entry, a
   * remembered search, an omnibox row its extension marked deletable. No confirmation; the
   * highlight moves to the row that takes its place instead of clearing (Chrome).
   */
  const removeRow = (index: number): boolean => {
    const row = results[index]
    if (!row || !forget(row)) return false
    const remaining = results.filter((_, i) => i !== index)
    setResults(remaining)
    const next = selectionAfterRemoval(index, remaining.length)
    setAction(-1)
    highlight(next, remaining)
    return true
  }

  /**
   * The phone's removal (OMN-17, Chrome for Android's): a hold on a removable row asks first –
   * the §9.23 prompt sheet (`RemoveSuggestionSheet`), Remove in the danger ink (§10.4) beside
   * Cancel – since a finger has no Shift+Delete and no X to aim at. The sheet takes the focus
   * from the field and gives it back when it goes (the keyboard with it), whichever way it is
   * answered; one question at a time.
   */
  const askRemoval = (item: Suggestion): void => {
    setAsking((open) => open ?? item)
  }

  /**
   * Remove: the entry goes at once; the row leaves on §11.4's collapse (`rowExit.ts`) – its
   * heading with it when it was its group's last – measured here, before anything moves, and
   * run from the layout effect below once the ghosts are out of the flow.
   */
  const removeFromCard = (item: Suggestion): void => {
    const current = resultsRef.current
    const index = current.findIndex((row) => row.id === item.id)
    // One exit at a time: a second answer while one runs waits for the next list.
    if (index < 0 || exitStop.current || exitList.current || !forget(current[index])) return
    const li = document.getElementById(`zen-omnibox-row-${index}`)?.closest('li')
    const list = li?.parentElement
    if (!li || !list) {
      setResults(current.filter((row) => row.id !== item.id))
      return
    }
    const group = headingLeavesWith(current, item) ? item.group! : null
    const headingEl = group ? childBy(list, 'data-group', group) : null
    const ghosts: Record<string, GhostBox> = { [item.id]: ghostBox(li) }
    if (group && headingEl) ghosts[headingKey(group)] = ghostBox(headingEl)
    exitList.current = { list, before: listOffsets(list) }
    setExit({ id: item.id, heading: group && headingEl ? group : null, ghosts })
  }

  // The ghosts are out of the flow and the rows below stand in their final slots: glide them
  // back from where they were and run the exit; at rest the leaving rows are spliced out.
  useLayoutEffect(() => {
    if (!exit) return
    const finish = (): void => {
      exitStop.current = null
      setResults((rows) => rows.filter((row) => row.id !== exit.id))
      setExit(null)
    }
    const measured = exitList.current
    exitList.current = null
    const list = measured?.list
    const row = list ? childBy(list, 'data-row', exit.id) : null
    if (!measured || !list || !row) {
      finish()
      return
    }
    const heading = exit.heading ? childBy(list, 'data-group', exit.heading) : null
    const ghosts = new Set([row, ...(heading ? [heading] : [])])
    exitStop.current = runRowExit(
      { row, heading },
      moverDeltas(measured.before, list, ghosts),
      finish
    )
    return () => {
      exitStop.current?.()
      exitStop.current = null
    }
  }, [exit])

  /**
   * Put the highlight on row `index` (`-1`: none), the field showing the row's text with the
   * caret at its end, or what was typed again when no row is highlighted.
   */
  const highlight = (index: number, rows: Suggestion[] = results): void => {
    setSelected(index)
    const row = index >= 0 ? rows[index] : null
    const fill = row ? row.fill || row.url || typedText : typedText
    setText(fill)
    setCaretSeq((n) => n + 1)
  }

  const moveSelection = (dir: 1 | -1): void => {
    setAction(-1)
    highlight(arrowStep(selected, results.length, dir))
  }

  /** PageDown / PageUp: as many rows as the list shows at once, the whole list when it fits. */
  const movePage = (dir: 1 | -1): void => {
    const list = document.getElementById('zen-omnibox-results')
    const row = list?.querySelector<HTMLElement>('li')
    const pageSize =
      list && row && row.offsetHeight > 0
        ? Math.max(1, Math.floor(list.clientHeight / row.offsetHeight))
        : results.length
    setAction(-1)
    highlight(pageStep(selected, results.length, dir, pageSize))
  }

  /**
   * Tab out of the bar (omnibox-50, Chrome's Tab past the popup's last row): the bar goes away
   * as on Escape – draft kept – and the keyboard lands on the toolbar control beside the address
   * (after it forwards, before it backwards). With no toolbar row the keyboard returns to the page.
   */
  const leaveToToolbar = (dir: 1 | -1): void => {
    const target = toolbarControlBesideAddress(dir === 1 ? 'next' : 'prev')
    close(true, target !== null)
    target?.focus()
  }

  /** How many trailing controls each row has, for Tab's walk (omnibox-50). */
  const rowActions = (): number[] =>
    popupClosed ? [] : results.map((row) => (removable(row) && !phone ? 1 : 0))

  /** Tab / Shift+Tab from the field or from a row's control. */
  const tabKey = (shift: boolean): void => {
    const intent = tabStep(selected, action, rowActions(), shift ? -1 : 1)
    if (intent.kind === 'leave') {
      leaveToToolbar(intent.dir)
      return
    }
    if (intent.selected !== selected) highlight(intent.selected)
    setAction(intent.action)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    const el = inputRef.current
    // A key during an IME composition is the IME's (a desktop CJK IME's Enter commits the
    // candidate), except Enter on the phone: Android keyboards keep the current word composing
    // (Gboard's underline) and let a hardware Enter through with the composition open, and
    // Chrome's omnibox submits on it. The field holds the composing word already.
    if (e.nativeEvent.isComposing && !(phone && e.key === 'Enter')) return
    switch (e.key) {
      case 'Escape': {
        e.preventDefault()
        // Over a page the field rests at its address; over none (a new tab, search mode) there
        // is nothing to revert to and the bar closes keeping its draft, as before.
        const pageText = tab && urlbar.mode === 'edit' ? restTextFor(tab, phone) : null
        const intent = escapeIntent({
          keywordMode: keywordMode !== null,
          // The phone's sheet has no popup stage: its rows are the sheet.
          popupOpen: !phone && results.length > 0 && !popupClosed,
          atRestText: pageText === null || text === pageText
        })
        switch (intent) {
          case 'exit-keyword':
            exitKeywordMode()
            return
          case 'close-popup':
            // The rows go, what was typed stays; the next key brings them back.
            requestSeq.current++
            setPopupClosed(true)
            setAction(-1)
            setSelected(-1)
            setTyped(lastTyped.current, false)
            return
          case 'revert': {
            // Esc restores the page's address (selected, read from the start); a further Esc
            // closes the bar. The draft is gone with the edit. On the phone the rest state is
            // the empty, search-ready field.
            const rest = pageText ?? ''
            requestSeq.current++
            drafts.delete(draftKey)
            rememberTyped(rest)
            setText(rest)
            setResults([])
            setSelected(-1)
            setAction(-1)
            if (el) {
              el.value = rest
              el.setSelectionRange(0, rest.length, 'backward')
              el.scrollLeft = 0
            }
            return
          }
          case 'close-bar':
            close(pageText === null)
            return
        }
        return
      }
      case 'Tab': {
        e.preventDefault()
        // Tab accepts the inline completion (design language v2 §9.22).
        if (el && hasCompletionTail(el) && !e.shiftKey) {
          setTyped(el.value, true)
          return
        }
        // An engine's keyword, host or name then Tab: keyword mode for it (tab-to-search).
        if (!e.shiftKey && !keywordMode && !phone && selected < 0) {
          const word = text.trim()
          const picked = word && !/\s/.test(word) ? matchEngineWord(word, engines, true) : null
          if (picked) {
            enterKeywordMode(picked, word)
            return
          }
        }
        if (phone) {
          // The sheet has no toolbar to leave for: Tab walks the rows, wrapping, as before.
          if (results.length > 0) moveSelection(e.shiftKey ? -1 : 1)
          return
        }
        tabKey(e.shiftKey)
        return
      }
      case 'ArrowDown':
      case 'ArrowUp':
        if (results.length === 0) return
        e.preventDefault()
        // After Escape put the popup away, an arrow brings the rows back and moves on.
        if (popupClosed) {
          setPopupClosed(false)
          if (e.key === 'ArrowDown' && selected === -1) {
            highlight(0)
            return
          }
        }
        moveSelection(e.key === 'ArrowUp' ? -1 : 1)
        return
      case 'PageDown':
      case 'PageUp':
        if (results.length === 0 || phone) return
        e.preventDefault()
        setPopupClosed(false)
        movePage(e.key === 'PageDown' ? 1 : -1)
        return
      case 'ArrowRight':
      case 'End':
        // The caret collapses to the end natively; the completion is now what was typed.
        if (el && hasCompletionTail(el) && !e.shiftKey) rememberTyped(el.value)
        return
      case 'Backspace':
        // Backspace on the empty query leaves keyword mode and brings the keyword text back.
        if (keywordMode && text === '') {
          e.preventDefault()
          exitKeywordMode()
        }
        return
      case 'Enter': {
        e.preventDefault()
        const { where, wwwCom } = submitTarget({
          ctrl: e.ctrlKey || e.metaKey,
          shift: e.shiftKey,
          alt: e.altKey
        })
        if (wwwCom) {
          // Ctrl+Enter: `www.` and `.com` around what was typed, never the completion nor a
          // highlighted row (BUG-015); Ctrl+Shift+Enter opens that in a new window.
          const typed = el && hasCompletionTail(el) ? lastTyped.current : text
          submit(null, { input: completeWwwCom(typed), where })
          return
        }
        submit(selected >= 0 && !popupClosed ? results[selected] : null, { where })
        return
      }
      case 'Delete':
        // Shift+Delete removes the highlighted removable row (Chrome); plain Delete does too when
        // a row is highlighted, since the field's caret then has nothing to delete.
        if (selected >= 0 && !popupClosed && removeRow(selected)) e.preventDefault()
        return
    }
  }

  /** Keys on a row's control (the X): Tab walks on, Escape returns to the field, arrows move. */
  const onActionKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (action < 0) return
    switch (e.key) {
      case 'Tab':
        e.preventDefault()
        tabKey(e.shiftKey)
        return
      case 'Escape':
        e.preventDefault()
        setAction(-1)
        return
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault()
        moveSelection(e.key === 'ArrowUp' ? -1 : 1)
        return
      case 'Delete':
        e.preventDefault()
        removeRow(selected)
        return
    }
  }

  // Hung from a toolbar pill (the tablet) the bar is always the pill's attached popup.
  const floating = !urlbar.attached && !anchor
  const style = useMemo(() => {
    if (!area) return undefined
    if (anchor) {
      // Hung `POPUP_GAP` under the pill and as wide as it (TB-21), down to the bottom of the
      // shell's box less a gutter – the keyboard's inset has already taken its share of the box.
      const top = anchor.y + anchor.height + POPUP_GAP
      return {
        left: anchor.x,
        top,
        width: anchor.width,
        maxHeight: Math.max(120, area.height - top - 8)
      }
    }
    const field = urlbarFieldBox(area, floating)
    return {
      left: field.x,
      top: field.y,
      width: field.width,
      // Never grow past the content area – on phones the keyboard takes most of it.
      maxHeight: Math.max(120, area.y + area.height - field.y - 8)
    }
  }, [floating, area, anchor])

  const placeholder = inKeyword ? `Search with ${engine.name}` : 'Search or enter address'
  // The field's native context menu ("Paste and Go") and the phone field's floating toolbar
  // ("Paste and go", OMN-23) act on the tab a submit would: the current one while editing, a new
  // one from the new-tab bar (`data-zen-menu`, read by the main process and by `ChromeWebView`).
  const menuTabId = tab && !submitsToNewTab() ? tab.id : undefined

  // What the desktop rows emphasise (omnibox-21): the typed terms – a `@keyword`'s query alone
  // – and nothing while the field still holds the page's own address, untouched (the rows are
  // for it, but it was not typed: Chrome bolds nothing there either) or in zero-suggest.
  const typedQuery =
    tab && typedText === restTextFor(tab, phone) ? '' : (textKeyword?.query ?? typedText)
  // §6: "Search with <Engine>" names the engine once, on the list's first search row – Zen's
  // heuristic row – and the search suggestions under it read bare; every other kind keeps its
  // trailing text (a page's host, an answer's expression, an engine row's "Search <engine>").
  const firstSearch = results.findIndex((r) => r.kind === 'search')

  // The rows that stay: a leaving row (OMN-17) is drawn as a ghost out of the flow and takes no
  // part in where the headings fall or which is outermost.
  const live = withoutExit(results, exit)
  /** The group of the nearest row that stays, `dir` rows away. */
  const liveGroup = (i: number, dir: 1 | -1): string | undefined => {
    let j = i + dir
    while (results[j] && results[j].id === exit?.id) j += dir
    return results[j]?.group
  }
  const rows = (sheet: boolean): JSX.Element[] =>
    results.flatMap((item, i) => {
      const leaving = exit?.id === item.id
      const row = (
        <SuggestionRow
          key={item.id}
          id={`zen-omnibox-row-${i}`}
          item={item}
          selected={i === selected}
          sheet={sheet}
          typed={sheet ? undefined : typedQuery}
          bare={!sheet && item.kind === 'search' && i !== firstSearch}
          onPick={(e) => {
            if (item.kind === 'clipboard') void pickClip()
            else
              submit(item, {
                where: clickTarget({
                  button: e.button,
                  ctrl: e.ctrlKey || e.metaKey,
                  shift: e.shiftKey,
                  alt: e.altKey
                })
              })
          }}
          // The desktop's remove X (omnibox-22) on the rows the core marks removable; the
          // phone's trailing controls (OMN-09, OMN-14) are as they were, and its removal is a
          // hold on the row that asks first (OMN-17).
          onRemove={!sheet && removable(item) ? () => removeRow(i) : undefined}
          onLongPress={sheet && removable(item) ? askRemoval : undefined}
          ghost={leaving ? exit.ghosts[item.id] : undefined}
          removeId={rowActionId(i, 0)}
          actionFocused={!sheet && i === selected && action === 0}
          onActionKeyDown={onActionKeyDown}
          onRefine={sheet && refinable(item) ? refine : undefined}
          clip={item.kind === 'clipboard' ? clip : undefined}
          onReveal={sheet && item.kind === 'clipboard' && !clip ? revealClip : undefined}
        />
      )
      // A group's heading over its rows: the shared v2 heading (§9.27's 15/600). The desktop
      // popup's (zero-suggest's "Recent searches", omnibox-20) at a popover list's beat, as the
      // tab search popover's – 12 above, 4 below, the first 4 under the field's hairline. The
      // phone card's (OMN-18) at the phone list's beat, keyed by the group so a heading that
      // stays across a keystroke keeps its element and only an arriving one fades in (§11.4:
      // in place, on opacity; nothing slides). A bottom-docked card lists its rows in reverse –
      // the first nearest the field – so there the heading follows the group's last row in the
      // DOM to stand over the group on screen. A leaving row's heading goes with it, as a
      // ghost, only when it was the group's last; otherwise the rows that stay carry it. A
      // heading to assistive technology too (TalkBack announces it and can jump by it), not a
      // presentational list item read as plain text; the options are the rows alone.
      const bottom = sheet && phoneEdge === 'bottom'
      const ghostHeading = leaving && exit.heading === item.group
      const boundary = liveGroup(i, bottom ? 1 : -1)
      const heads = item.group && (leaving ? ghostHeading : item.group !== boundary)
      // The outermost heading, at the list's edge, sits 8 in rather than the 20 between groups.
      const outer = !leaving && (bottom ? live[live.length - 1] : live[0])?.id === item.id
      const heading = heads ? (
        <li
          key={headingKey(item.group!)}
          role="heading"
          aria-level={2}
          className={cn(
            'zen-v2-heading',
            sheet ? 'zen-omnibox-sheet-heading' : 'zen-omnibox-heading'
          )}
          data-testid="urlbar-group-heading"
          data-group={item.group}
          data-outer={outer || undefined}
          data-leaving={ghostHeading || undefined}
          aria-hidden={ghostHeading || undefined}
          style={ghostHeading ? exit.ghosts[headingKey(item.group!)] : undefined}
        >
          {item.group}
        </li>
      ) : null
      if (!heading) return [row]
      return bottom ? [row, heading] : [heading, row]
    })

  const activeRow = selected >= 0 ? `zen-omnibox-row-${selected}` : undefined
  // The highlight stays in view once the list scrolls (§9.20's scrolling chrome): the row the
  // keyboard moved to is brought to the nearer edge, as a menulist's option is – the field, not
  // the row, holds the focus, so no focus() scrolls for it.
  useEffect(() => {
    if (!activeRow || phoneEdge) return
    const option = document.getElementById(activeRow)
    ;(option?.closest('.zen-omnibox-row') ?? option)?.scrollIntoView({ block: 'nearest' })
  }, [activeRow, phoneEdge])
  // An address or text dragged over the field goes where a submit would (lib/dnd.ts, Chrome's
  // paste and go); the field shows it will take the drop (§9.4).
  const dropInto = dropStore.use((s) => s.key === 'address:')

  // The empty field's trailing controls (OMN-19, OMN-22), each where the host can answer it.
  const voice = voiceSearchAvailable(state.capabilities)
  const camera = qrScanAvailable(state.capabilities)

  if (phoneEdge) {
    return (
      <>
        {/* The hold's question (OMN-17): a §9.23 prompt over the omnibox, in the frame's dialog host. */}
        {asking && (
          <RemoveSuggestionSheet
            item={asking}
            onClose={() => setAsking(null)}
            onConfirm={() => removeFromCard(asking)}
          />
        )}
        <PhoneSheet
          edge={phoneEdge}
          sheetRef={sheetRef}
          fieldRef={fieldRef}
          onDismiss={() => close(true)}
          header={
            pageHeader ? (
              <PageHeader
                tab={pageHeader}
                edge={phoneEdge}
                onShare={isShareableUrl(pageHeader.url) ? sharePage : null}
                onCopy={copyPageLink}
                onEdit={editPageUrl}
              />
            ) : null
          }
          rows={rows(true)}
          hint={results.length === 0 && !text ? placeholder : null}
          field={
            <div
              // The trailing slot's control is a §9.3 icon button, 44 × 44 with the 20 glyph: as
              // tall as the pill, round, flush with its end, so it is the pill's end cap.
              className="zen-omnibox-field flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full pl-2"
              style={fieldGrowFrom(
                phoneBarForHost(state.settings.phoneBar, phoneBarOffered(state.capabilities))
              )}
            >
              {/* The engine's mark (NTP-09): its favicon when it is not the vendor's default, the
                letter tile otherwise; the morph's double draws the same (FakeboxMorphLayer). */}
              <EngineFieldGlyph engine={engine} fallback="tile" />
              <input
                ref={inputRef}
                value={text}
                onChange={onChange}
                onKeyDown={onKeyDown}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={() => (composing.current = false)}
                // The placeholder is the field's name (A11Y-01): this WebView reads a text field's
                // label and its placeholder both, so a label saying the same words was heard twice.
                placeholder={placeholder}
                data-testid="urlbar-input"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                // Chrome's URL keyboard (OMN-25): the `/` and `.` keys up front, Go on the action key,
                // no capitalisation or correction of what is typed.
                inputMode="url"
                enterKeyHint="go"
                data-zen-menu="urlbar"
                data-zen-menu-tab={menuTabId}
                className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--zen-muted)]"
              />
              {text ? (
                <button
                  type="button"
                  className="zen-toolbar-button h-11 w-11 shrink-0 rounded-full"
                  aria-label="Clear"
                  // Keep the input focused so the keyboard stays where it is.
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={clear}
                >
                  <X className="h-5 w-5" strokeWidth={1.75} />
                </button>
              ) : (
                (voice || camera) && (
                  // OMN-19 and OMN-22: the empty field offers the mic and the camera where Clear
                  // will be; the listening or scan sheet takes the frame from the bar, and its result
                  // loads where a submit here would. The last control is the 44 px pill's round end
                  // cap; one before it is the §9.3 box.
                  <>
                    {voice && (
                      <button
                        type="button"
                        className={cn(
                          'zen-toolbar-button h-11 w-11 shrink-0',
                          !camera && 'rounded-full'
                        )}
                        aria-label="Search by voice"
                        onClick={() =>
                          void startVoiceSearch({
                            tabId: tab?.id ?? null,
                            newTab: submitsToNewTab()
                          })
                        }
                      >
                        <Mic className="h-5 w-5" strokeWidth={1.75} />
                      </button>
                    )}
                    {camera && (
                      <button
                        type="button"
                        className="zen-toolbar-button h-11 w-11 shrink-0 rounded-full"
                        aria-label="Scan a QR code"
                        onClick={() =>
                          void startQrScan({ tabId: tab?.id ?? null, newTab: submitsToNewTab() })
                        }
                      >
                        <Camera className="h-5 w-5" strokeWidth={1.75} />
                      </button>
                    )}
                  </>
                )
              )}
            </div>
          }
        />
      </>
    )
  }

  /*
    The desktop bar on design language v2 §6 "Floating URL bar": a neutral opaque surface at radius
    12 with the URL bar shadow (anchored under the pill it is a popover, §9.20: radius 8, hairline,
    panel shadow); the field is the palette's first row – 62 with a hairline under it, the
    engine's glyph at its start, the typed text's inline completion selected, and nothing at its
    end (no go button, no badge) – then the dropdown (shell pass 7(b), the lead's ruling on
    #289): `.zen-v2-row`s one line at 50 whatever the row's kind, the 16 kind glyph at stroke
    1.5, the title with the typed part in the heading weight, then ` — ` and the host or the
    engine at 69% truncating from the end, "Search with <Engine>" on the first search row only,
    the keyboard's row on `--v2-fill` (§9.6), the remove X trailing (§9.34), and the hint strip
    at 13/20. Page tokens only (§9.29).
  */
  return (
    // The empty pane's bar (`urlbar.pane`) lets presses through to the chrome around it – the
    // pane's "Choose a tab" button, the split's headers – and closes on one itself (the
    // `pointerdown` listener above); the frame-wide bar takes the press and closes on it.
    <div
      className={cn('absolute inset-0 z-30', urlbar.pane && 'pointer-events-none')}
      onMouseDown={urlbar.pane ? undefined : () => close(true)}
    >
      <div
        ref={panelRef}
        className="zen-omnibox zen-animate-in absolute flex flex-col overflow-hidden pointer-events-auto"
        data-surface="page"
        data-attached={!floating}
        data-urlbar-pane={urlbar.pane ? urlbar.tabId : undefined}
        // The open URL bar is the toolbar's field: F6 from it moves on to the next pane and
        // puts it away (lib/panes.ts).
        data-pane="toolbar"
        style={style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="zen-omnibox-input-row flex shrink-0 items-center"
          data-drop-into={dropInto || undefined}
        >
          {/* The engine's glyph replaces the default's in keyword mode (omnibox-08). */}
          <span className="zen-omnibox-engine" title={`Search engine: ${engine.name}`}>
            {engine.glyph}
          </span>
          {chipLabel &&
            // The keyword chip (omnibox-08, -26): the pill chip chassis in the badge look the
            // dropdown already has; slid in over 150 ms as Chrome's. A click leaves keyword mode
            // (Backspace on the empty field and Escape do for the keyboard); the `@scope` text
            // chip has nothing to leave, so it stays inert.
            (keywordMode ? (
              <PillChip
                key={keywordMode.engine.id}
                label={`${chipLabel}. Leave keyword mode`}
                title="Leave keyword mode"
                className="zen-omnibox-badge zen-omnibox-keyword-chip"
                data-keyword-chip=""
                onPointerDown={keepFocus}
                onActivate={() => {
                  exitKeywordMode()
                  inputRef.current?.focus()
                }}
              >
                {chipLabel}
              </PillChip>
            ) : (
              <span
                className="zen-omnibox-badge zen-omnibox-keyword-chip"
                data-keyword-chip=""
                title={chipLabel}
              >
                {chipLabel}
              </span>
            ))}
          <input
            ref={inputRef}
            value={text}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            placeholder={placeholder}
            data-testid="urlbar-input"
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-label="Search or enter address"
            aria-autocomplete="both"
            aria-expanded={results.length > 0 && !popupClosed}
            aria-controls="zen-omnibox-results"
            aria-activedescendant={activeRow}
            data-zen-menu="urlbar"
            data-zen-menu-tab={menuTabId}
            className="zen-omnibox-input h-full min-w-0 flex-1 bg-transparent outline-none"
          />
          {/* Nothing trails the input (§6): Zen hides the go button, and a "Current tab" badge
              that is on in the bar's usual mode says nothing – the hint strip's "↵ Open ·
              Alt↵ New tab" is where the destination is told (pr-123's deferred badge verdict,
              closed by the lead's check on #289). */}
        </div>
        {results.length > 0 && !popupClosed && (
          <ul
            ref={fadeResults}
            id="zen-omnibox-results"
            role="listbox"
            className="zen-omnibox-results min-h-0 max-h-[520px] flex-1 overflow-y-auto"
          >
            {rows(false)}
          </ul>
        )}
        {/* The hint strip (§4: 13 on the small line, deemphasised), the key chips 20 tall. */}
        <div className="zen-omnibox-footer zen-kbd-hint flex shrink-0 items-center">
          <span>
            <kbd className="zen-omnibox-kbd">↵</kbd> Open
          </span>
          <span>
            <kbd className="zen-omnibox-kbd">Alt ↵</kbd> New tab
          </span>
          <span>
            <kbd className="zen-omnibox-kbd">Ctrl ↵</kbd> www.com
          </span>
          <span>
            <kbd className="zen-omnibox-kbd">Tab</kbd> Complete
          </span>
          <span>
            <kbd className="zen-omnibox-kbd">@</kbd> Engines, bookmarks, history, tabs
          </span>
          <span className="flex-1" />
          <span className="min-w-0 truncate">Type a command like “compact mode”</span>
        </div>
      </div>
    </div>
  )
}

/**
 * The phone's omnibox. The field sits exactly where the address pill was – in the bar band at
 * `edge`, riding the keyboard inset – and the suggestions take over the whole content frame,
 * ordered so the first one is nearest the field and the list grows towards the middle of the
 * screen. Nothing of the page shows through: the frame is the surface, whatever the keyboard's
 * height or the phone's orientation.
 */
function PhoneSheet({
  edge,
  field,
  header,
  rows,
  hint,
  onDismiss,
  sheetRef,
  fieldRef
}: {
  edge: PhoneBarPosition
  field: JSX.Element
  /** The search-ready header (OMN-05), pinned at the field's end of the sheet; the list scrolls past it. */
  header: JSX.Element | null
  rows: JSX.Element[]
  /** Shown in the empty sheet before anything is typed. */
  hint: string | null
  onDismiss: () => void
  /** Painted by the back gesture (transform and opacity only). */
  sheetRef: RefObject<HTMLDivElement | null>
  fieldRef: RefObject<HTMLDivElement | null>
}): JSX.Element {
  const bottom = edge === 'bottom'
  // A long list dissolves at the edge that has more past it, like every scroller in the chrome.
  const fadeRows = useFadeEdges<HTMLUListElement>({ axis: 'y' })
  // The pill's focus motion (MOT-07, lib/omniboxFocus.ts) writes its value on the layer per
  // frame: the sheet and the field under it read it, so a frame recalculates the omnibox alone.
  const bindFocus = useOmniboxFocusBinding()
  const bandStyle = {
    left: 'var(--zen-inset-left)',
    right: 'var(--zen-inset-right)',
    [bottom ? 'bottom' : 'top']: 0,
    paddingTop: bottom ? 6 : 'calc(var(--zen-inset-top) + 6px)',
    paddingBottom: bottom ? 'calc(var(--zen-inset-bottom) + 6px)' : 6
  }
  const sheetStyle = {
    left: 'calc(var(--zen-inset-left) + var(--zen-padding))',
    right: 'calc(var(--zen-inset-right) + var(--zen-padding))',
    top: bottom
      ? 'calc(var(--zen-inset-top) + var(--zen-padding))'
      : 'calc(var(--zen-inset-top) + var(--zen-phone-bar))',
    bottom: bottom
      ? 'calc(var(--zen-inset-bottom) + var(--zen-phone-bar))'
      : 'calc(var(--zen-inset-bottom) + var(--zen-padding))',
    transformOrigin: bottom ? '50% 100%' : '50% 0%'
  }
  // The omnibox is the pill grown over the frame: a window surface (v2 §9.29), so the chips, the
  // Refine arrows and the clipboard row's Show draw in the window family through the control roles.
  return (
    <div
      ref={bindFocus}
      className="zen-omnibox-layer absolute inset-0 z-30"
      onMouseDown={onDismiss}
    >
      <div
        ref={sheetRef}
        data-surface="window"
        className={cn(
          'zen-omnibox-sheet zen-animate-fade absolute flex overflow-hidden',
          bottom ? 'flex-col-reverse' : 'flex-col'
        )}
        style={sheetStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {header}
        <div className="relative min-h-0 flex-1">
          {rows.length > 0 ? (
            <ul
              ref={fadeRows}
              role="listbox"
              aria-label="Suggestions"
              data-edge={edge}
              className={cn(
                'zen-omnibox-list absolute inset-0 flex overflow-y-auto p-1',
                bottom ? 'flex-col-reverse' : 'flex-col'
              )}
              style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}
            >
              {rows}
            </ul>
          ) : (
            hint && (
              <div className="absolute inset-0 flex items-center justify-center px-10 text-center text-[13px] text-[var(--zen-muted)]">
                {hint}
              </div>
            )
          )}
        </div>
      </div>
      <div
        ref={fieldRef}
        className="absolute flex items-center px-2"
        style={bandStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {field}
      </div>
    </div>
  )
}

/**
 * Where the grow animation starts: the pill's slot as a shift and a scale of the band's inner
 * width, so the field's backdrop sets out exactly from where the pill was. The slot is what the
 * bar's buttons leave it: 44 px plus a 4 px gap for each control either side of the pill.
 */
function fieldGrowFrom(layout: PhoneBarLayout): React.CSSProperties {
  const { width } = viewportStore.get()
  const { left, right } = uiStore.get().insets
  const slotLeft = layout.left.length * (BAR_BUTTON + BAR_GAP)
  const slotRight = layout.right.length * (BAR_BUTTON + BAR_GAP)
  const band = width - left - right - 2 * BAR_PADDING
  const scale = band > slotLeft + slotRight ? (band - slotLeft - slotRight) / band : 0.5
  return {
    '--zen-field-shift': `${slotLeft}px`,
    '--zen-field-scale': scale.toFixed(3)
  } as React.CSSProperties
}

/**
 * Length of the header's cross-fade when the page row's content changes in place – the title
 * or favicon of a still-loading page arriving, the tab navigating under the open bar (v2 §11.4:
 * on opacity, in the same slot, no slide and no cut; the same fade under reduced motion).
 */
export const HEADER_SWAP_FADE_MS = 120

/**
 * The page row's face (glyph, title, address) cross-fades when what it draws changes while the
 * header is up: the face it showed until this commit is kept as a ghost over the new one, the
 * ghost fading out and the new face in over {@link HEADER_SWAP_FADE_MS}, both in the row's one
 * slot. `key` is what the face draws; a change of key while mounted starts the fade, the first
 * render does not (the header itself arrives with the sheet). Returns the ghost to draw (null
 * when none) with the refs the fade animates.
 */
function usePageCrossFade(
  key: string,
  face: JSX.Element
): [
  ghost: { key: number; face: JSX.Element } | null,
  faceRef: RefObject<HTMLDivElement | null>,
  ghostRef: RefObject<HTMLDivElement | null>
] {
  const faceRef = useRef<HTMLDivElement | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  /** What the last commit drew: the face a change of key keeps as the ghost. */
  const shown = useRef<{ key: string; face: JSX.Element } | null>(null)
  const [ghost, setGhost] = useState<{ key: number; face: JSX.Element } | null>(null)
  useLayoutEffect(() => {
    const last = shown.current
    shown.current = { key, face }
    if (last && last.key !== key) {
      setGhost((g) => ({ key: (g?.key ?? 0) + 1, face: last.face }))
    }
  }, [key, face])
  useLayoutEffect(() => {
    if (!ghost) return
    // Started before the paint, so the first frame already has the ghost over the new face.
    const fade = (el: HTMLElement | null, from: number, to: number): Animation | null =>
      el?.animate?.([{ opacity: from }, { opacity: to }], {
        duration: HEADER_SWAP_FADE_MS,
        easing: 'linear',
        fill: to === 0 ? 'forwards' : 'none'
      }) ?? null
    const anims = [fade(ghostRef.current, 1, 0), fade(faceRef.current, 0, 1)].filter(
      (a): a is Animation => a !== null
    )
    // A cancelled animation rejects its `finished`; nothing waits on it.
    for (const a of anims) a.finished.catch(() => undefined)
    // The ghost goes after the fade's length, with or without WAAPI (the unit tests' DOM).
    const timer = setTimeout(
      () => setGhost((g) => (g?.key === ghost.key ? null : g)),
      HEADER_SWAP_FADE_MS
    )
    return () => {
      clearTimeout(timer)
      for (const a of anims) a.cancel()
    }
  }, [ghost])
  return [ghost, faceRef, ghostRef]
}

/** A control inside a row or the header keeps the field focused: no blur, no keyboard flicker. */
const keepFocus = (e: React.PointerEvent): void => {
  e.preventDefault()
  e.stopPropagation()
}

const noop = (): void => undefined

/**
 * The search-ready header (OMN-05, Chrome for Android): the page the bar was opened over – its
 * icon, title and address as a static two-line row – and Share, Copy link and Edit as v2 buttons
 * in the window family. The page row is the half nearest the field at either dock: at the top
 * the row comes first and the chips under it; at a bottom-docked bar the header is reversed
 * (`.zen-omnibox-header[data-edge='bottom']`), so the row sits just over the field with the
 * chips above it, the hairline on the list's side. `onShare` null leaves the Share chip out
 * (a page whose address is not http(s)).
 */
function PageHeader({
  tab,
  edge,
  onShare,
  onCopy,
  onEdit
}: {
  tab: Tab
  edge: PhoneBarPosition
  onShare: (() => void) | null
  onCopy: () => void
  onEdit: () => void
}): JSX.Element {
  const [faviconBroken, setFaviconBroken] = useState(false)
  const url = pageTextFor(tab)
  const shown = displayUrl(url) || url
  const title = tab.customTitle ?? (tab.title || shown)
  const favicon = tab.favicon && !faviconBroken ? tab.favicon : null
  const face = (
    <>
      {favicon ? (
        <img
          src={favicon}
          alt=""
          className="zen-omnibox-page-glyph rounded-[3px]"
          referrerPolicy="no-referrer"
          onError={() => setFaviconBroken(true)}
        />
      ) : (
        <Globe className="zen-omnibox-page-glyph" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">
        <span className="zen-omnibox-page-title block truncate">{title}</span>
        <span className="zen-omnibox-page-url block truncate">{shown}</span>
      </span>
    </>
  )
  const [ghost, faceRef, ghostRef] = usePageCrossFade(
    `${title}\u001f${shown}\u001f${favicon ?? ''}`,
    face
  )
  const chip = (label: string, Glyph: typeof Share2, onClick: () => void): JSX.Element => (
    <button
      type="button"
      className="zen-v2-button zen-omnibox-chip"
      onPointerDown={keepFocus}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <Glyph aria-hidden="true" />
      {label}
    </button>
  )
  return (
    <div className="zen-omnibox-header shrink-0" data-edge={edge} data-testid="urlbar-page-header">
      <div className="zen-v2-row zen-omnibox-page" data-static>
        <div className="zen-omnibox-page-face" ref={faceRef}>
          {face}
        </div>
        {ghost ? (
          <div
            key={ghost.key}
            className="zen-omnibox-page-face zen-omnibox-page-ghost"
            aria-hidden="true"
            ref={ghostRef}
          >
            {ghost.face}
          </div>
        ) : null}
      </div>
      <div className="zen-omnibox-chips">
        {onShare ? chip('Share', Share2, onShare) : null}
        {chip('Copy link', Link, onCopy)}
        {chip('Edit', Pencil, onEdit)}
      </div>
    </div>
  )
}

function SuggestionRow({
  id,
  item,
  selected,
  sheet,
  onPick,
  onRemove,
  removeId,
  actionFocused,
  onActionKeyDown,
  onRefine,
  clip,
  onReveal,
  onLongPress,
  ghost,
  typed = '',
  bare = false
}: {
  id: string
  item: Suggestion
  /** The keyboard's highlight; hovering a row never moves it (Chrome), only a click picks. */
  selected: boolean
  /** A row of the phone sheet: touch height (44); the desktop list's rows are §6's one line at 50. */
  sheet: boolean
  onPick: (e: React.MouseEvent) => void
  /**
   * The phone row's hold (OMN-17): on a removable row it asks to remove the suggestion; a right
   * click counts as the hold, for a mouse. The tap that ends a hold picks nothing.
   */
  onLongPress?: (item: Suggestion) => void
  /**
   * The row is on its way out (OMN-17, `rowExit.ts`): drawn as a ghost at this box, out of the
   * list's flow, inert and hidden from assistive technology, while its exit runs.
   */
  ghost?: GhostBox
  /**
   * What the user typed, for the desktop row's bold match (omnibox-21, `highlight.ts`): a
   * keyword mode's terms alone; empty at rest over a page and in zero-suggest, when nothing
   * is emphasised.
   */
  typed?: string
  /**
   * A desktop search suggestion under the list's first search row (§6, Zen's heuristic row):
   * its text alone, the engine having been named once above it.
   */
  bare?: boolean
  /**
   * The desktop row's remove X (omnibox-22): shown on hover, on the highlighted row and while
   * it has the keyboard; `removeId` is its element id, the target Tab moves the keyboard to.
   */
  onRemove?: () => void
  removeId?: string
  /** The X has the keyboard (Tab reached it, omnibox-50); the row keeps its highlight. */
  actionFocused?: boolean
  onActionKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void
  /** A query row's Refine arrow (OMN-09): the row's text into the field, nothing submitted. */
  onRefine?: (item: Suggestion) => void
  /** The clipboard row's content once revealed (OMN-14); the row then shows it. */
  clip?: ClipboardContent | null
  /** The clipboard row's Show, while its content is still behind it. */
  onReveal?: () => void
}): JSX.Element {
  const touch = useRef(false)
  // A favicon that fails to load leaves the kind's glyph, as Chrome's globe (never a blank cell).
  const [faviconBroken, setFaviconBroken] = useState(false)
  const { Icon, page } = suggestionIcon(item)
  const hold = useLongPress(onLongPress ? () => onLongPress(item) : noop)
  const pointerProps = {
    onPointerDown: (e: React.PointerEvent) => {
      // Keep the input focused (no blur → no keyboard flicker on phones). A mouse picks on
      // press like Firefox; a finger picks on tap so the list can still be scrolled. A row with
      // a hold leaves the right button to it (its context menu is the hold's question).
      e.preventDefault()
      if (e.pointerType === 'mouse') {
        if (!onLongPress || e.button === 0) onPick(e)
      } else touch.current = true
    },
    onClick: (e: React.MouseEvent) => {
      if (!touch.current) return
      touch.current = false
      onPick(e)
    }
  }
  // The hold's handlers ride along on a row that has one: its recognition swallows the tap that
  // ends it, so the row is not also picked (`useLongPress`).
  const optionProps = onLongPress
    ? {
        ...hold.handlers,
        onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
          pointerProps.onPointerDown(e)
          hold.handlers.onPointerDown(e)
        },
        onClick: (e: React.MouseEvent<HTMLElement>) => {
          if (hold.swallowsClick()) {
            touch.current = false
            return
          }
          pointerProps.onClick(e)
        }
      }
    : pointerProps
  // The desktop row's glyph is a §9.3 row glyph – 16 at stroke 1.5 in the lead slot's
  // deemphasised ink (`V2_GLYPH`); the phone sheet's row keeps its own.
  const icon =
    item.favicon && !faviconBroken && !page ? (
      <img
        src={item.favicon}
        alt=""
        className="h-4 w-4 rounded-[3px]"
        referrerPolicy="no-referrer"
        onError={() => setFaviconBroken(true)}
      />
    ) : sheet ? (
      <Icon className="h-4 w-4 shrink-0 opacity-60" />
    ) : (
      <Icon className={V2_GLYPH} aria-hidden />
    )
  if (sheet) {
    // The row is the option (what a tap picks) and, after it, its control: Show or the Refine
    // arrow. ARIA makes an option's children presentational, so a button inside one is not in the
    // accessibility tree (TalkBack cannot reach it, nor can UiAutomation); the buttons are the
    // option's siblings in the row, the row itself carrying the highlight across its whole width.
    return (
      <li
        role="presentation"
        className="zen-suggestion zen-suggestion-sheet flex shrink-0 items-center pr-2.5"
        data-selected={selected}
        data-kind={item.kind}
        data-row={item.id}
        // The group the row is sectioned under (OMN-18), for whoever reads the card off the
        // DOM; the heading's own mark is `data-group`, which the exit looks the heading up by.
        data-section={item.group}
        data-leaving={ghost ? true : undefined}
        aria-hidden={ghost ? true : undefined}
        style={ghost}
      >
        <div
          id={id}
          role="option"
          aria-selected={selected}
          className="flex min-w-0 flex-1 cursor-default items-center gap-3 self-stretch pl-2.5"
          {...optionProps}
        >
          {icon}
          <span className="min-w-0 flex-1 truncate text-[14px]" data-testid="urlbar-row-title">
            {clip ? clip.text : item.title}
          </span>
          {/* A query row with a Refine arrow reads as its text alone, as Chrome's: the verbatim
              row (no arrow) keeps naming the engine, so the others need not repeat it and lose
              their words to it. */}
          <span
            className="max-w-[45%] truncate text-[13px] text-[var(--zen-muted)]"
            data-testid="urlbar-row-subtitle"
          >
            {clip ? item.title : onRefine ? '' : item.subtitle}
          </span>
          {item.kind === 'tab' && <ArrowRight className="h-3.5 w-3.5 opacity-50" />}
        </div>
        {onReveal && (
          <button
            type="button"
            className="zen-v2-button zen-omnibox-reveal ml-3"
            onPointerDown={keepFocus}
            onClick={onReveal}
          >
            Show
          </button>
        )}
        {onRefine && (
          <button
            type="button"
            className="zen-v2-icon-button zen-omnibox-refine ml-3"
            aria-label="Refine"
            onPointerDown={keepFocus}
            onClick={() => onRefine(item)}
          >
            <ArrowUpLeft aria-hidden="true" />
          </button>
        )}
      </li>
    )
  }
  // The desktop row (v2 draft §6, §9.34, shell pass 7(b)): the shared `.zen-v2-row` on one line
  // at 50 whatever its kind – the 16 kind glyph, the title, then ` — ` and the host or the
  // engine in the deemphasised ink, the line truncating from its end (§4: a suggestion row
  // stays one line at every scale, as Zen's, Firefox's and Chrome's) – whose body is the option
  // (its remove X is a sibling in the row: a button inside an option would be presentational
  // to assistive technology). The row takes the press, so the whole row is the target, the X's
  // press excepted; hovering is the row's own fill and never moves the keyboard's highlight.
  const trailing = bare ? '' : item.subtitle
  const rowPointerProps = {
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as Element).closest('button')) return
      pointerProps.onPointerDown(e)
    },
    onClick: (e: React.MouseEvent) => {
      if ((e.target as Element).closest('button')) return
      pointerProps.onClick(e)
    }
  }
  return (
    <li
      role="presentation"
      className="zen-v2-row zen-omnibox-row cursor-default"
      data-selected={selected}
      data-kind={item.kind}
      data-action-focused={actionFocused || undefined}
      {...rowPointerProps}
    >
      <div
        id={id}
        role="option"
        aria-selected={selected}
        className="zen-omnibox-row-body flex min-w-0 flex-1 items-center"
      >
        <span className="zen-omnibox-row-icon flex shrink-0 items-center justify-center">
          {icon}
        </span>
        <span className="zen-omnibox-row-title">
          <Highlighted text={item.title} ranges={matchRanges(item.kind, item.title, typed)} />
        </span>
        {trailing && (
          <span className="zen-omnibox-row-host">
            <span aria-hidden="true"> — </span>
            <Highlighted
              text={trailing}
              ranges={matchRanges(item.kind, trailing, typed, 'description')}
            />
          </span>
        )}
        {item.kind === 'tab' && (
          <span className="zen-omnibox-row-hint">
            Switch to tab
            <ArrowRight aria-hidden />
          </span>
        )}
      </div>
      {onRemove && (
        // The 28 px v2 icon button at the row's trailing edge (§9.34), up on hover, on the
        // highlighted row and while it has the keyboard; Chrome removes without confirmation.
        <button
          type="button"
          id={removeId}
          tabIndex={-1}
          className="zen-v2-icon-button zen-omnibox-remove"
          aria-label="Remove suggestion"
          title="Remove suggestion"
          data-testid="urlbar-remove-suggestion"
          onPointerDown={keepFocus}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          onKeyDown={onActionKeyDown}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </li>
  )
}
