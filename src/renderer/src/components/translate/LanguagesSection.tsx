import type { JSX, ReactNode } from 'react'
import { Children } from 'react'
import { ArrowUp, Trash2, type LucideIcon } from 'lucide-react'
import type { TranslatePreferences } from '@shared/translate'
import type { UIState } from '@shared/types'
import { languageName } from '@shared/languageNames'
import { run } from '@renderer/lib/api'
import {
  languageOptions,
  modelOptions,
  pairKey,
  pairLabel,
  useRegistryModels,
  type LanguageOption
} from '@renderer/lib/translate'
import { cn, formatBytes } from '@renderer/lib/utils'
import { V2CheckRow, V2IconButton } from '../extensions/v2'
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
 * category's builder (`pages/settings/sections.tsx`), never this pane.
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
    </div>
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
 * trailing it are – grown around them (§9.21: 36 around a 28 icon button) when it has any, else
 * at the base 32.
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
    <div className={cn('zen-v2-row', controls && 'zen-translate-control-row')} data-static="">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="zen-translate-caption shrink-0">{detail}</span>}
      {children}
    </div>
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
 * around its 32; the row is not the target, the menulist is).
 */
function AddRow({
  label,
  placeholder,
  options,
  onPick
}: {
  label: string
  placeholder: string
  options: LanguageOption[]
  onPick: (value: string) => void
}): JSX.Element {
  return (
    <div className="zen-v2-row zen-translate-control-row zen-translate-add" data-static="">
      <Menulist
        value={null}
        placeholder={placeholder}
        options={options}
        onChange={onPick}
        label={label}
      />
    </div>
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
