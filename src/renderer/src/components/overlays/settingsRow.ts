import type { ReactNode } from 'react'
import { Children, isValidElement } from 'react'

/** What a settings row holds when it is a single control: decides its hit area and layout. */
export type RowControl = 'switch' | 'select' | 'input' | 'segmented'

/** Component types and the kind of control each one is. */
export type ControlTypes = ReadonlyArray<readonly [unknown, RowControl]>

/** The kind of the row's only child, if that child is one of the known controls. */
export function rowControl(children: ReactNode, types: ControlTypes): RowControl | null {
  // toArray already drops null, undefined and booleans.
  const only = Children.toArray(children)
  if (only.length !== 1 || !isValidElement(only[0])) return null
  const type = only[0].type
  return types.find(([t]) => t === type)?.[1] ?? null
}

/**
 * Whether the row's text labels the control, so the whole row toggles, opens or focuses it. A
 * group of radio buttons carries its own name; buttons, several controls and plain text are not
 * labelled by the row either.
 */
export function rowIsLabel(control: RowControl | null): boolean {
  return control !== null && control !== 'segmented'
}

/** A two-way pill whose labels together run past this many characters is too wide for a phone row. */
const SEGMENTED_INLINE_CHARS = 18

/**
 * Controls wide enough to starve the label in a narrow column: fields, selects, and a segmented
 * pill of three or more (or of two with long labels). Where the column is narrow (a phone) the
 * row stacks them under the label.
 */
export function rowStacks(control: RowControl | null, children: ReactNode): boolean {
  if (control === 'select' || control === 'input') return true
  if (control !== 'segmented') return false
  const only = Children.toArray(children).find(isValidElement)
  const props = only?.props as { options?: Array<{ label?: string }> } | undefined
  const options = props?.options ?? []
  if (options.length > 2) return true
  return options.reduce((n, o) => n + (o.label?.length ?? 0), 0) > SEGMENTED_INLINE_CHARS
}
