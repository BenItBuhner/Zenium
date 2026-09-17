import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { ArrowUp, Trash2 } from 'lucide-react'
import type { TranslateModelInfo, TranslatePreferences } from '@shared/translate'
import type { UIState } from '@shared/types'
import { languageName } from '@shared/languageNames'
import { cmd, run } from '@renderer/lib/api'
import { languageOptions, pairLabel } from '@renderer/lib/translate'
import { formatBytes } from '@renderer/lib/utils'
import { Checkbox, IconButton, Menulist } from './controls'

/**
 * Settings > Languages: whether Zenium offers to translate, the languages the user reads (the
 * first is what pages are translated into), the always and never lists, the sites that are
 * never offered, and the translation models on the device. Laid out on the v2 draft: 17/600
 * group headings over 15 deemphasised descriptions, a bordered card for every group that has
 * its own actions, 16 px checkboxes, bordered menulists and 32 px rows.
 */
export function LanguagesSection({ state }: { state: UIState }): JSX.Element {
  const { translate } = state
  const prefs = translate.preferences
  const set = (patch: Partial<TranslatePreferences>): void => run('translate.setPreferences', patch)
  const rule = (language: string, value: 'always' | 'never' | 'ask'): void =>
    run('translate.setLanguageRule', { language, rule: value })

  if (!translate.available) {
    return (
      <div className="zen-translate-settings">
        <Group
          title="Translation"
          description="This build of Zenium does not include the translation engine."
        />
      </div>
    )
  }

  return (
    <div className="zen-translate-settings">
      <Group
        title="Translation"
        description="Pages in other languages are translated on this device, with models Zenium downloads the first time a language pair is used. Nothing leaves the device."
      >
        <Checkbox checked={prefs.autoOffer} onChange={(autoOffer) => set({ autoOffer })}>
          Offer to translate pages in other languages
        </Checkbox>
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
              <IconButton
                label={`Offer to translate ${site} again`}
                onClick={() =>
                  set({ neverTranslateSites: prefs.neverTranslateSites.filter((s) => s !== site) })
                }
              >
                <Trash2 />
              </IconButton>
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

/** A heading and its description, over content that is boxed in a card when the group has actions. */
function Group({
  title,
  description,
  card,
  children
}: {
  title: string
  description?: string
  card?: boolean
  children?: ReactNode
}): JSX.Element {
  return (
    <section className="zen-translate-group">
      <h3 className="zen-translate-group-title">{title}</h3>
      {description && <p className="zen-translate-description">{description}</p>}
      {children !== undefined &&
        (card ? <div className="zen-translate-card">{children}</div> : children)}
    </section>
  )
}

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
  return (
    <div className="zen-translate-row">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="zen-translate-caption shrink-0 tabular-nums">{detail}</span>}
      {children}
    </div>
  )
}

/** An empty list (§9.17): one centred sentence, no full stop, top-anchored in the card. */
function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="zen-translate-empty">{children}</div>
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
      {codes.map((code, index) => (
        <Row key={code} label={languageName(code)}>
          {onPromote && index > 0 && (
            <IconButton
              label={`Make ${languageName(code)} the first`}
              onClick={() => onPromote(code)}
            >
              <ArrowUp />
            </IconButton>
          )}
          {onRemove && (
            <IconButton label={`Remove ${languageName(code)}`} onClick={() => onRemove(code)}>
              <Trash2 />
            </IconButton>
          )}
        </Row>
      ))}
      {remaining.length > 0 && (
        <div className="zen-translate-row zen-translate-row-add">
          <Menulist
            value={null}
            placeholder="Add a language…"
            options={languageOptions(remaining)}
            onChange={onAdd}
            label={addLabel}
          />
        </div>
      )}
    </Group>
  )
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const pairKey = (m: { from: string; to: string }): string => `${m.from}:${m.to}`

/**
 * The translation models: those on the device with their size and a way to remove them, and a
 * menulist to fetch another pair ahead of time. Every model comes from Mozilla's Firefox
 * Translations set under the licence the registry names.
 */
function ModelsGroup({ state }: { state: UIState }): JSX.Element {
  const { installed, registryDate, modelLicense } = state.translate
  const [models, setModels] = useState<TranslateModelInfo[]>([])
  const [pending, setPending] = useState<string[]>([])

  // The registry's pairs, read again whenever the set on the device changes.
  useEffect(() => {
    let cancelled = false
    cmd('translate.models', undefined).then(
      (list) => {
        if (!cancelled) setModels(list)
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [installed])

  const download = (key: string): void => {
    const model = models.find((m) => pairKey(m) === key)
    if (!model) return
    setPending((p) => [...p, key])
    void cmd('translate.downloadModel', { from: model.from, to: model.to })
      .catch(() => undefined)
      .then(() => setPending((p) => p.filter((k) => k !== key)))
  }

  const available = models.filter((m) => !m.installed && !pending.includes(pairKey(m)))
  const downloading = models.filter((m) => !m.installed && pending.includes(pairKey(m)))
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
          <IconButton
            label={`Remove the ${pairLabel(m.from, m.to)} model`}
            onClick={() => run('translate.removeModel', { from: m.from, to: m.to })}
          >
            <Trash2 />
          </IconButton>
        </Row>
      ))}
      {downloading.map((m) => (
        <Row key={pairKey(m)} label={pairLabel(m.from, m.to)} detail="Downloading…" />
      ))}
      {available.length > 0 && (
        <div className="zen-translate-row zen-translate-row-add">
          <Menulist
            value={null}
            placeholder="Download a model…"
            options={available.map((m) => ({
              value: pairKey(m),
              label: `${pairLabel(m.from, m.to)} (${formatBytes(m.bytes)})`
            }))}
            onChange={download}
            label="Download a translation model"
          />
        </div>
      )}
      {installed.length > 0 && (
        <p className="zen-translate-caption pt-2">{formatBytes(total)} on this device.</p>
      )}
    </Group>
  )
}
