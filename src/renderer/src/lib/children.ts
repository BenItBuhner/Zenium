import { Children, Fragment, isValidElement, type ElementType, type ReactNode } from 'react'

/**
 * Whether any of `children` is an element of one of `types`. Looks through arrays and fragments
 * but not into what other components render: a Row decides its layout from what it was handed.
 */
export function hasElementOfType(children: ReactNode, types: readonly ElementType[]): boolean {
  return Children.toArray(children).some((child) => {
    if (!isValidElement(child)) return false
    if (types.includes(child.type as ElementType)) return true
    if (child.type === Fragment) {
      const { children: inner } = child.props as { children?: ReactNode }
      return hasElementOfType(inner, types)
    }
    return false
  })
}
