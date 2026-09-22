import type { JSX, RefObject } from 'react'
import { Search, X } from 'lucide-react'
import { SEARCH_TABS_PLACEHOLDER } from '@renderer/lib/overviewSearch'

/** The id of the field's input: what the preview host's `type:` step and the drivers find. */
export const OVERVIEW_SEARCH_ID = 'overview-search'

/**
 * The tab search's field (matrix TAB-21; v2 §9.12): the phone field, 40 tall at the grid's
 * gutter, pinned between the segment and the pane it filters – the bottom of what stays put.
 * On the overview's window backdrop it is a resting control in the URL bar's own fill
 * (`--v2-urlbar`) with the panel's shadow and no hairline – the pill's look, as the new tab
 * page's field wears it – its text in the page ink: a page surface standing on the window
 * (§9.29). The trailing X is one control with two meanings, the ones Escape and back have
 * (`TabOverview`): with a query it clears the field and keeps it up; empty, it closes the field.
 * The field takes the keyboard only from the header's magnifier (a user's tap, `inputRef`),
 * never as the overview opens.
 */
export function OverviewSearchField({
  value,
  inputRef,
  onChange,
  onClear,
  onClose
}: {
  value: string
  inputRef: RefObject<HTMLInputElement | null>
  onChange: (value: string) => void
  onClear: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="zen-overview-search shrink-0 px-3 pb-2" data-testid="overview-search">
      <div className="zen-phone-field zen-overview-search-field">
        <Search className="zen-phone-field-icon h-5 w-5" strokeWidth={1.75} aria-hidden />
        <input
          id={OVERVIEW_SEARCH_ID}
          ref={inputRef}
          type="search"
          value={value}
          // The label names the field, the placeholder is its example text (§9.12): different
          // words, so a reader hears a name and a hint, not the same thing twice (A11Y-01).
          aria-label="Search tabs"
          placeholder={SEARCH_TABS_PLACEHOLDER}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="zen-phone-field-clear zen-v2-field-clear"
          aria-label={value ? 'Clear search' : 'Close search'}
          data-testid="overview-search-clear"
          onClick={value ? onClear : onClose}
        >
          <X className="h-5 w-5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  )
}
