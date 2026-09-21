import type { FormEvent, JSX, ReactNode } from 'react'
import { Children, useCallback, useEffect, useId, useState } from 'react'
import { ArrowUp, Trash2, type LucideIcon } from 'lucide-react'
import type { TranslatePreferences } from '@shared/translate'
import type { UIState } from '@shared/types'
import { languageName } from '@shared/languageNames'
import {
  SPELLCHECK_LANGUAGES_MAX,
  type SpellcheckDictionaryStatus,
  type SpellcheckLanguage
} from '@shared/spellcheck'
import { cmd, run } from '@renderer/lib/api'
import {
  languageOptions,
  modelOptions,
  pairKey,
  pairLabel,
  useRegistryModels,
  type LanguageOption
} from '@renderer/lib/translate'
import { cn, formatBytes } from '@renderer/lib/utils'
import { V2Button, V2CheckRow, V2Field, V2FormField, V2IconButton } from '../extensions/v2'
import { ControlRow } from './ControlRow'
import { Menulist } from './Menulist'

/**
 * Settings > Languages, the desktop pane: whether Zenium offers to translate, the languages the
 * user reads (the first is what pages are translated into), the always and never lists, the
 * sites that are never offered, and the translation models on the device. Laid out on the v2
 * draft (§6 settings page): the pane opens on its 22/600 "Translation" section title (§9.26)
 * and every list is named by a 15/600 sub-heading over a 15 deemphasised description and a
 * bordered card (§9.27: a title above a card is a sub-heading, never 17). The rows are the
 * shared `.zen-v2-row` (§9.34): the check row a target, every list row static (`data-static`,
 * its icon buttons being the targets) and grown around its control (§9.21); the checkbox, the
 * icon buttons and the menulist are the shared primitives. The `SettingsPanel` shows it behind
 * the `translate` capability. On a phone Settings is a tab and these rows are the `languages`
 * category's builder (`pages/settings/sections.tsx`), never this pane. Chrome's "Spell check"
 * section (`SpellcheckGroups`) follows the translation groups, as it follows the languages on
 * chrome://settings/languages.
 */
export function LanguagesSection({ state }: { state: UIState }): JSX.Element {
  const { translate } = state
  const prefs = translate.preferences
  const set = (patch: Partial<TranslatePreferences>): void => run('translate.setPreferences', patch)
  const rule = (language: string, value: 'always' | 'never' | 'ask'): void =>
    run('translate.setLanguageRule', { language, rule: value })

  return (
    <div className="zen-translate-settings">
      <Group
        title="Translation"
        description="Pages in other languages are translated on this device, with models Zenium downloads the first time a language pair is used. Nothing leaves the device."
        section
      >
        <V2CheckRow
          label="Offer to translate pages in other languages"
          checked={prefs.autoOffer}
          onChange={(autoOffer) => set({ autoOffer })}
        />
      </Group>

      <LanguageList
        title="Languages you read"
        description="Pages in these languages are shown as they are; the first one is the language other pages are translated into."
        codes={prefs.preferred}
        languages={translate.languages}
        addLabel="Add a language you read"
        onAdd={(code) => set({ preferred: [...prefs.preferred, code] })}
        onRemove={
          prefs.preferred.length > 1
            ? (code) => set({ preferred: prefs.preferred.filter((c) => c !== code) })
            : undefined
        }
        onPromote={(code) =>
          set({ preferred: [code, ...prefs.preferred.filter((c) => c !== code)] })
        }
      />

      <LanguageList
        title="Always translate"
        description="Pages in these languages are translated as soon as they load, without asking."
        codes={prefs.alwaysTranslate}
        languages={translate.languages}
        addLabel="Add a language to always translate"
        onAdd={(code) => rule(code, 'always')}
        onRemove={(code) => rule(code, 'ask')}
        empty="No languages yet"
      />

      <LanguageList
        title="Never translate"
        description="Zenium never offers to translate pages in these languages."
        codes={prefs.neverTranslate}
        languages={translate.languages}
        addLabel="Add a language to never translate"
        onAdd={(code) => rule(code, 'never')}
        onRemove={(code) => rule(code, 'ask')}
        empty="No languages yet"
      />

      <Group
        title="Sites never translated"
        description="Zenium does not offer to translate these sites. Add one from the translation bar's options while you are on the site."
        card
      >
        {prefs.neverTranslateSites.length === 0 ? (
          <Empty>No sites yet</Empty>
        ) : (
          prefs.neverTranslateSites.map((site) => (
            <Row key={site} label={site}>
              <RowAction
                icon={Trash2}
                label={`Offer to translate ${site} again`}
                onClick={() =>
                  set({ neverTranslateSites: prefs.neverTranslateSites.filter((s) => s !== site) })
                }
              />
            </Row>
          ))
        )}
      </Group>

      <ModelsGroup state={state} />

      <SpellcheckGroups state={state} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Spell check (CT-07, CT-19)
// ---------------------------------------------------------------------------

/** What a language's dictionary is doing, as the row's deemphasised detail; nothing while it is ready. */
function dictionaryDetail(status: SpellcheckDictionaryStatus): string | undefined {
  if (status === 'downloading') return 'Downloading dictionary…'
  if (status === 'failed') return 'Dictionary download failed'
  return undefined
}

/**
 * Chrome's Settings › Languages › Spell check: the switch ("Check the spelling of text fields"),
 * the languages the fields are checked in – each with what its dictionary is doing, a way to stop
 * checking in it, and a menulist to add one of the host's other dictionaries up to Chrome's five
 * – and the custom dictionary ("Customize spell check"). The list is Chrome's dependent group:
 * with the switch off its rows read at .4 and take no press (§9.30), the switch alone stays
 * live. A host whose checker follows the OS's languages (macOS) shows where they are chosen
 * instead of a list it cannot change; a host with no checker of the browser's own (the WebView)
 * says the keyboard's checker does the work and leads to its settings.
 */
export function SpellcheckGroups({ state }: { state: UIState }): JSX.Element {
  const status = state.spellcheck
  const settings = state.settings.spellcheck
  if (!status.available) {
    return (
      <Group
        title="Spell check"
        description="Text fields are checked by the spell checker of the keyboard in use. Its languages, and whether it marks or corrects words as you type, are chosen with the keyboard in the system settings."
      >
        <ControlRow>
          <V2Button onClick={() => run('spellcheck.openKeyboardSettings', undefined)}>
            Open keyboard settings
          </V2Button>
        </ControlRow>
      </Group>
    )
  }
  const checked = status.languages.filter((l) => l.enabled)
  const remaining = status.languages.filter((l) => !l.enabled)
  const atLimit = checked.length >= SPELLCHECK_LANGUAGES_MAX
  const off = !settings.enabled
  return (
    <>
      <Group
        title="Spell check"
        description="Misspelt words in text fields are underlined as you type; their menu offers corrections and Add to Dictionary."
      >
        <V2CheckRow
          label="Check the spelling of text fields"
          checked={settings.enabled}
          onChange={(enabled) => run('spellcheck.setEnabled', { enabled })}
        />
      </Group>
      {status.systemLanguages ? (
        <Group
          title="Languages"
          description="The system's spell checker checks in the languages chosen for it in System Settings › Keyboard; a text field's menu switches between them."
        />
      ) : (
        <Group
          title="Languages"
          description={`Text fields are checked in up to ${SPELLCHECK_LANGUAGES_MAX} languages at a time. A dictionary is downloaded the first time a language is checked in and kept on this device.`}
          card
        >
          {checked.length === 0 && <Empty>No languages yet</Empty>}
          {checked.map((language) => (
            <SpellcheckLanguageRow key={language.code} language={language} disabled={off} />
          ))}
          {atLimit ? (
            <div
              className="zen-v2-row zen-translate-caption"
              data-static=""
              aria-disabled={off || undefined}
            >
              <span>
                Up to {SPELLCHECK_LANGUAGES_MAX} languages can be checked at a time. Remove one to
                add another.
              </span>
            </div>
          ) : (
            remaining.length > 0 && (
              <AddRow
                label="Add a language to check in"
                placeholder="Add a language…"
                options={remaining.map((l) => ({ value: l.code, label: l.name }))}
                onPick={(code) => run('spellcheck.setLanguage', { code, on: true })}
                disabled={off}
              />
            )
          )}
        </Group>
      )}
      <CustomDictionaryGroup disabled={off} />
    </>
  )
}

/** One language the fields are checked in: its name, what its dictionary is doing, Remove. */
function SpellcheckLanguageRow({
  language,
  disabled
}: {
  language: SpellcheckLanguage
  disabled: boolean
}): JSX.Element {
  const detail = dictionaryDetail(language.status)
  return (
    <ControlRow data-language={language.code} aria-disabled={disabled || undefined}>
      <span className="min-w-0 flex-1 truncate">{language.name}</span>
      {detail && (
        <span
          className={cn(
            'zen-translate-caption shrink-0',
            language.status === 'failed' && 'zen-translate-danger'
          )}
        >
          {detail}
        </span>
      )}
      <V2IconButton
        icon={Trash2}
        label={`Stop checking in ${language.name}`}
        disabled={disabled}
        onClick={() => run('spellcheck.setLanguage', { code: language.code, on: false })}
      />
    </ControlRow>
  )
}

/** The words of the profile's custom dictionary, read once and again after every change. */
function useCustomWords(): { words: string[] | null; refresh: () => void } {
  const [words, setWords] = useState<string[] | null>(null)
  const refresh = useCallback((): void => {
    cmd('spellcheck.words', undefined)
      .then((list) => setWords(Array.isArray(list) ? list : []))
      .catch(() => setWords([]))
  }, [])
  useEffect(refresh, [refresh])
  return { words, refresh }
}

/**
 * Chrome's "Customize spell check": the words the checker never marks, added here or with a
 * field's Add to Dictionary, each with a way to remove it, and a form (§9.12) to add one – a
 * single word, refused with the field's own message otherwise, or when it is there already.
 */
function CustomDictionaryGroup({ disabled }: { disabled: boolean }): JSX.Element {
  const { words, refresh } = useCustomWords()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const fieldId = useId()
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const word = draft.trim()
    if (!word) return
    if (/\s/.test(word)) {
      setError('Enter one word without spaces')
      return
    }
    if (words?.some((w) => w.toLowerCase() === word.toLowerCase())) {
      setError('This word is in the dictionary already')
      return
    }
    cmd('spellcheck.addWord', { word })
      .then((added) => {
        if (!added) {
          setError('This word could not be added')
          return
        }
        setDraft('')
        setError(undefined)
        refresh()
      })
      .catch(() => setError('This word could not be added'))
  }
  return (
    <Group
      title="Custom dictionary"
      description="Words the checker never marks. Add to Dictionary in a text field's menu puts a word here too."
      card
    >
      {words !== null && words.length === 0 && <Empty>No words yet</Empty>}
      {(words ?? []).map((word) => (
        <ControlRow key={word} data-word={word} aria-disabled={disabled || undefined}>
          <span className="min-w-0 flex-1 truncate">{word}</span>
          <V2IconButton
            icon={Trash2}
            label={`Remove ${word} from the dictionary`}
            disabled={disabled}
            onClick={() => void cmd('spellcheck.removeWord', { word }).then(refresh, refresh)}
          />
        </ControlRow>
      ))}
      <ControlRow
        as="form"
        className="zen-translate-add"
        aria-disabled={disabled || undefined}
        onSubmit={submit}
      >
        <V2FormField
          id={fieldId}
          label="Add a new word"
          error={error}
          className="min-w-0 flex-1"
          actions={
            <V2Button type="submit" disabled={disabled || draft.trim() === ''}>
              Add
            </V2Button>
          }
        >
          {(aria) => (
            <V2Field
              {...aria}
              value={draft}
              placeholder="colour"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              onChange={(e) => {
                setDraft(e.target.value)
                if (error) setError(undefined)
              }}
            />
          )}
        </V2FormField>
      </ControlRow>
    </Group>
  )
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/**
 * A heading, its description and the content they introduce, boxed in a card when the group has
 * its own actions. The pane's opening group carries the 22/600 section title (§9.26: line-height
 * 28, its description 4 under it, 16 from the description to the first row); every other group
 * is named by a 15/600 sub-heading with its description 4 under it and 16 to the card's edge
 * (§9.27). One name per card: the card itself has none inside.
 */
function Group({
  title,
  description,
  section,
  card,
  children
}: {
  title: string
  description?: string
  /** The pane's section title rather than a sub-heading. */
  section?: boolean
  card?: boolean
  children?: ReactNode
}): JSX.Element {
  const Heading = section ? 'h2' : 'h3'
  return (
    <section className="zen-translate-group">
      <Heading className={section ? 'zen-translate-section-title' : 'zen-translate-group-title'}>
        {title}
      </Heading>
      {description && <p className="zen-translate-description">{description}</p>}
      {children !== undefined && (
        <div className={cn('zen-translate-group-body', card && 'zen-v2-card zen-translate-card')}>
          {children}
        </div>
      )}
    </section>
  )
}

/**
 * A list entry: the shared row's static form (§9.34) – the row is not a target, the icon buttons
 * trailing it are – grown around them (§9.21: 36 around a 28 icon button, the primitive's
 * `data-control`) when it has any, else at the base 32.
 */
function Row({
  label,
  detail,
  children
}: {
  label: string
  /** A deemphasised value after the label (a size, a state). */
  detail?: string
  children?: ReactNode
}): JSX.Element {
  const controls = Children.toArray(children).length > 0
  return (
    <ControlRow control={controls}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="zen-translate-caption shrink-0">{detail}</span>}
      {children}
    </ControlRow>
  )
}

/** A row's action: the shared icon button (§9.3), its label the tooltip and the accessible name. */
function RowAction({
  icon,
  label,
  onClick
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
}): JSX.Element {
  return <V2IconButton icon={icon} label={label} onClick={onClick} />
}

/**
 * An empty list (§9.17, inside a card): one plain static row at the card's gutter, one sentence
 * in the deemphasised ink, no full stop, no centring and no top gap – the card's 4 px rows inset
 * is all the air around it.
 */
function Empty({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="zen-v2-row zen-translate-empty" data-static="">
      {children}
    </div>
  )
}

/**
 * The control that adds to a list: the shared menulist in a static row of its own (§9.21: 40
 * around its 32, the primitive's `data-control`; the row is not the target, the menulist is).
 */
function AddRow({
  label,
  placeholder,
  options,
  onPick,
  disabled = false
}: {
  label: string
  placeholder: string
  options: LanguageOption[]
  onPick: (value: string) => void
  /** A dependent row whose parent is off (§9.30): the menulist reads at .4 and opens nothing. */
  disabled?: boolean
}): JSX.Element {
  return (
    <ControlRow className="zen-translate-add" aria-disabled={disabled || undefined}>
      <Menulist
        value={null}
        placeholder={placeholder}
        options={options}
        onChange={onPick}
        label={label}
        disabled={disabled}
      />
    </ControlRow>
  )
}

/** A list of languages with a menulist to add one, in a card of its own. */
function LanguageList({
  title,
  description,
  codes,
  languages,
  addLabel,
  onAdd,
  onRemove,
  onPromote,
  empty
}: {
  title: string
  description: string
  codes: string[]
  /** Every language the registry knows. */
  languages: string[]
  addLabel: string
  onAdd: (code: string) => void
  /** Absent when the list may not shrink any further. */
  onRemove?: (code: string) => void
  /** Move a language to the top (the preferred list's order matters). */
  onPromote?: (code: string) => void
  empty?: string
}): JSX.Element {
  const remaining = languages.filter((code) => !codes.includes(code))
  return (
    <Group title={title} description={description} card>
      {codes.length === 0 && empty && <Empty>{empty}</Empty>}
      {codes.map((code, index) => {
        const promote = onPromote && index > 0
        const remove = onRemove !== undefined
        return (
          <Row key={code} label={languageName(code)}>
            {promote && (
              <RowAction
                icon={ArrowUp}
                label={`Make ${languageName(code)} the first`}
                onClick={() => onPromote(code)}
              />
            )}
            {remove && (
              <RowAction
                icon={Trash2}
                label={`Remove ${languageName(code)}`}
                onClick={() => onRemove(code)}
              />
            )}
          </Row>
        )
      })}
      {remaining.length > 0 && (
        <AddRow
          label={addLabel}
          placeholder="Add a language…"
          options={languageOptions(remaining)}
          onPick={onAdd}
        />
      )}
    </Group>
  )
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * The translation models: those on the device with their size and a way to remove them, and a
 * menulist to fetch another pair ahead of time. Every model comes from Mozilla's Firefox
 * Translations set under the licence the registry names.
 */
function ModelsGroup({ state }: { state: UIState }): JSX.Element {
  const { installed, downloading, registryDate, modelLicense } = state.translate
  // The registry's pairs, read again whenever the set on the device changes; the pairs on the
  // device or on their way (the engine lists a download from the moment it is asked for) are
  // left out of the menulist.
  const onDevice = [...installed, ...downloading]
  const models = useRegistryModels(onDevice.map(pairKey).join(' ')) ?? []
  const available = modelOptions(models, onDevice)
  const download = (key: string): void => {
    const model = models.find((m) => pairKey(m) === key)
    if (model) run('translate.downloadModel', { from: model.from, to: model.to })
  }
  const total = installed.reduce((sum, m) => sum + m.bytes, 0)

  return (
    <Group
      title="Translation models"
      description={`Downloaded the first time a language pair is translated and kept on this device. Mozilla's Firefox Translations models (${modelLicense}); list from ${registryDate}.`}
      card
    >
      {installed.length === 0 && downloading.length === 0 && (
        <Empty>No models on this device yet</Empty>
      )}
      {installed.map((m) => (
        <Row key={pairKey(m)} label={pairLabel(m.from, m.to)} detail={formatBytes(m.bytes)}>
          <RowAction
            icon={Trash2}
            label={`Remove the ${pairLabel(m.from, m.to)} model`}
            onClick={() => run('translate.removeModel', { from: m.from, to: m.to })}
          />
        </Row>
      ))}
      {downloading.map((m) => (
        <Row key={pairKey(m)} label={pairLabel(m.from, m.to)} detail="Downloading…" />
      ))}
      {available.length > 0 && (
        <AddRow
          label="Download a translation model"
          placeholder="Download a model…"
          options={available}
          onPick={download}
        />
      )}
      {installed.length > 0 && (
        // The total is a live count and no target: a static row in the caption ink (§9.34).
        <div className="zen-v2-row zen-translate-caption" data-static="">
          {formatBytes(total)} on this device
        </div>
      )}
    </Group>
  )
}
