import type { JSX } from 'react'
import { INTERNAL_PAGES } from '@shared/internalPages'
import type { Tab, UIState } from '@shared/types'
import { PageColumn, PageTitleBlock } from '../PageFrame'
import { PRIVACY_NOTICE, TERMS } from './legalText'
import { Prose } from './Prose'

/**
 * The legal pages (SET-55; Chrome's Privacy notice and Terms of service rows): one component
 * for `zen://privacy-notice` and `zen://terms`, from Settings › Legal – the shared page frame's
 * title block over the page's text (`legalText.ts`) drawn as prose. No actions, no search: a
 * page to read.
 */
export function LegalPage({
  id
}: {
  id: 'privacy-notice' | 'terms'
  state: UIState
  tab: Tab
}): JSX.Element {
  const page = INTERNAL_PAGES[id]
  return (
    <PageColumn
      testId={`${id}-page`}
      header={<PageTitleBlock title={page.title} titleId={`${id}-title`} />}
    >
      <Prose text={id === 'terms' ? TERMS : PRIVACY_NOTICE} testId={`${id}-text`} />
    </PageColumn>
  )
}
