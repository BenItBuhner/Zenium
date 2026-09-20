import type { JSX, KeyboardEvent, Ref } from 'react'
import { useRef, useState } from 'react'
import { CreditCard, KeyRound, Lock, MapPin, type LucideIcon } from 'lucide-react'
import type { AutofillPicker, AutofillPickerItem, FormGroup, ReauthOutcome } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { Btn, Footer, TitleBlock } from './controls'
import { PassphraseForm } from './PassphraseForm'

const GROUP_GLYPH: Record<FormGroup, LucideIcon> = {
  login: KeyRound,
  address: MapPin,
  card: CreditCard
}

const GROUP_LABEL: Record<FormGroup, string> = {
  login: 'Saved logins',
  address: 'Saved addresses',
  card: 'Saved cards'
}

/** The picker is asking for the vault passphrase before it fills `itemId`. */
interface Asking {
  itemId: string
  /** A refused attempt: the field reports it and asks again. */
  error: string | null
}

/**
 * The account, address and card picker (design language v2 §9.20, §9.21): the matching entries
 * for the focused field as rows – a 16 px favicon or glyph, the title, a description line for a
 * login from another subdomain, the address or the card holder – and after a hairline the row
 * that opens the manager. One highlight follows the pointer and the arrow keys; Enter fills the
 * active row, Escape closes. A password or a card number behind a passphrase turns the panel
 * into the one-field unlock step and back.
 *
 * The same panel serves the desktop popup surface (`AutofillSurface`, where it is the popover,
 * opening on its first row so Enter has a target) and the phone's strip above the keyboard
 * (`PickerStrip`, where it is the strip's content and no row is lit until a key moves the
 * highlight – a lit row under a thumb reads as pressed); the density tokens size its rows for
 * each. Mount it with `key={picker.id}` so a new picker starts from its list.
 */
export function PickerPanel({
  picker,
  contentRef,
  className,
  highlightFirst = true,
  onFilled
}: {
  picker: AutofillPicker
  /** The panel's content box, for a host that sizes the surface to it. */
  contentRef?: Ref<HTMLDivElement>
  className?: string
  /** Open with the first row highlighted (the pointer's popover); false on touch. */
  highlightFirst?: boolean
  /**
   * A row filled the field (the core closes the picker): the strip's tap took the keyboard from
   * the page, which gets it back here. The popup surface's window does that in the core.
   */
  onFilled?: () => void
}): JSX.Element {
  const [active, setActive] = useState(highlightFirst ? 0 : -1)
  const [asking, setAsking] = useState<Asking | null>(null)
  const [busy, setBusy] = useState(false)
  const [setup, setSetup] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Back was pressed while an attempt ran: its refusal must not bring the step back. */
  const leftStep = useRef(false)
  const count = picker.items.length + 1
  const Glyph = GROUP_GLYPH[picker.group]

  const close = (): void => run('autofill.pick', { id: picker.id, itemId: null })

  const pick = async (itemId: string, passphrase?: string): Promise<void> => {
    setBusy(true)
    leftStep.current = false
    let result: ReauthOutcome<null>
    try {
      result = await cmd('autofill.pick', { id: picker.id, itemId, passphrase })
    } catch {
      result = { status: 'denied' }
    }
    setBusy(false)
    if (leftStep.current && result.status !== 'ok') return
    switch (result.status) {
      case 'ok':
        // The core closes the picker with the fill.
        onFilled?.()
        return
      case 'passphrase':
        setAsking({ itemId, error: null })
        return
      case 'setup-passphrase':
        setSetup(true)
        return
      case 'denied':
        // A wrong passphrase keeps the picker (the core keeps it too); anything else closed it.
        if (passphrase !== undefined)
          setAsking({ itemId, error: result.reason ?? 'That passphrase is not right. Try again.' })
        return
    }
  }

  const activate = (index: number): void => {
    if (index < 0) return
    if (index < picker.items.length) void pick(picker.items[index].id)
    else run('autofill.manage', undefined)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (asking || setup) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActive((i) => (i + 1) % count)
        return
      case 'ArrowUp':
        e.preventDefault()
        setActive((i) => (i < 0 ? count - 1 : (i - 1 + count) % count))
        return
      case 'Home':
        e.preventDefault()
        setActive(0)
        return
      case 'End':
        e.preventDefault()
        setActive(count - 1)
        return
      case 'Enter':
        e.preventDefault()
        activate(active)
        return
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        close()
        return
    }
  }

  let content: JSX.Element
  if (setup) {
    content = (
      <div ref={contentRef} className="zen-v2-af-notice">
        <TitleBlock
          title="Set a vault passphrase first"
          description="This device cannot verify you, so Zenium needs a passphrase on the vault before it fills passwords and cards. Set one in Settings."
        />
        <div className="zen-v2-af-form">
          <Footer count={2}>
            <Btn onClick={close}>Not now</Btn>
            <Btn variant="primary" onClick={() => run('autofill.manage', undefined)}>
              Open Settings
            </Btn>
          </Footer>
        </div>
      </div>
    )
  } else if (asking) {
    const item = picker.items.find((i) => i.id === asking.itemId)
    content = (
      <PassphraseStep
        contentRef={contentRef}
        group={picker.group}
        item={item ?? null}
        error={asking.error}
        busy={busy}
        onBack={() => {
          leftStep.current = true
          setAsking(null)
        }}
        onSubmit={(passphrase) => void pick(asking.itemId, passphrase)}
      />
    )
  } else {
    content = (
      <div ref={contentRef} className="zen-v2-af-list">
        <div role="listbox" aria-label={GROUP_LABEL[picker.group]} className="contents">
          {picker.items.map((item, index) => (
            <Row
              key={item.id}
              item={item}
              glyph={Glyph}
              active={active === index}
              disabled={busy}
              onHover={() => setActive(index)}
              onPick={() => void pick(item.id)}
            />
          ))}
        </div>
        <div className="zen-v2-af-rule" role="separator" />
        <button
          type="button"
          className="zen-v2-row zen-v2-af-row"
          data-nav=""
          data-active={active === picker.items.length || undefined}
          disabled={busy}
          onPointerEnter={() => setActive(picker.items.length)}
          onClick={() => run('autofill.manage', undefined)}
        >
          <span className="zen-v2-af-row-icon">
            <Glyph aria-hidden />
          </span>
          <span className="zen-v2-af-row-text">
            <span className="zen-v2-af-row-title">{picker.manageLabel}…</span>
          </span>
        </button>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={cn('zen-v2-af zen-v2-af-body', className)}
      data-surface="page"
      onKeyDown={onKeyDown}
    >
      {content}
    </div>
  )
}

function Row({
  item,
  glyph: Glyph,
  active,
  disabled,
  onHover,
  onPick
}: {
  item: AutofillPickerItem
  glyph: LucideIcon
  active: boolean
  disabled: boolean
  onHover: () => void
  onPick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-active={active || undefined}
      className="zen-v2-row zen-v2-af-row"
      disabled={disabled}
      onPointerEnter={onHover}
      onClick={onPick}
    >
      <span className="zen-v2-af-row-icon">
        {item.favicon ? <img src={item.favicon} alt="" draggable={false} /> : <Glyph aria-hidden />}
      </span>
      <span className="zen-v2-af-row-text">
        <span className="zen-v2-af-row-title">{item.title}</span>
        {item.subtitle && <span className="zen-v2-af-row-desc">{item.subtitle}</span>}
      </span>
      {item.needsPassphrase && (
        <span
          className="zen-v2-af-row-trailing zen-v2-af-row-lock"
          title="Asks for the vault passphrase"
        >
          <Lock aria-hidden />
        </span>
      )}
    </button>
  )
}

/**
 * The unlock step: the shared `PassphraseForm` (§9.12, §9.30 – the field read-only with its
 * masked value while the vault works, Unlock alone busy, Back at .4; a refusal clears and
 * refocuses the field under its validation text) under a title block naming what it fills. The
 * field takes the keyboard as the step comes up, so the popup surface holds it until the answer.
 */
function PassphraseStep({
  contentRef,
  group,
  item,
  error,
  busy,
  onBack,
  onSubmit
}: {
  contentRef?: Ref<HTMLDivElement>
  group: FormGroup
  item: AutofillPickerItem | null
  error: string | null
  busy: boolean
  onBack: () => void
  onSubmit: (passphrase: string) => void
}): JSX.Element {
  const what =
    group === 'card'
      ? `the card ${item?.title ?? ''}`.trim()
      : `the password for ${item?.title ?? 'this login'}`
  return (
    <div ref={contentRef} className="zen-v2-af-notice">
      <TitleBlock title="Unlock to fill" description={`Your vault passphrase fills ${what}.`} />
      <PassphraseForm
        error={error}
        busy={busy}
        cancel="Back"
        onCancel={onBack}
        onSubmit={onSubmit}
      />
    </div>
  )
}
