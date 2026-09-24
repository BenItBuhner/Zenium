import type { JSX } from 'react'
import type { Tab, UIState } from '@shared/types'
import { releasePageUrl } from '@shared/updates'
import { run } from '@renderer/lib/api'
import { PageColumn, PageEmpty, PageTitleBlock } from '../PageFrame'
import { Prose } from './Prose'

/**
 * The What's new page (`zen://whats-new`, SET-54; Chrome's What's new tab, from Settings ›
 * About): a chrome page tab on the shared page frame – the "What's new" title block with the
 * running version 15 at 69% under it and "Release notes" in its trailing slot (the version's
 * release page, in a tab of this browser) – over the release's highlights as the updater's check
 * brought them (`UpdateStatus.notes`: the `## Highlights` of the running version's release,
 * read on the same request the check makes, no request of the page's own), drawn as prose.
 * Until a check has brought them the body is §9.17's one sentence; the title's action stands
 * either way, so the notes are one tap off.
 */
export function WhatsNewPage({ state }: { state: UIState; tab: Tab }): JSX.Element {
  const version = state.version
  const notes = state.updates.notes
  const current = notes && notes.version === version ? notes : null
  return (
    <PageColumn
      testId="whats-new-page"
      header={
        <PageTitleBlock
          title="What’s new"
          titleId="whats-new-title"
          description={`Zenium ${version}`}
          actions={
            <button
              type="button"
              className="zen-v2-button"
              data-testid="whats-new-release"
              onClick={() => run('tab.create', { url: releasePageUrl(version), active: true })}
            >
              Release notes
            </button>
          }
        />
      }
    >
      {current ? (
        <Prose text={current.text} testId="whats-new-notes" />
      ) : (
        <PageEmpty testId="whats-new-empty">
          The notes for this version come with the next update check
        </PageEmpty>
      )}
    </PageColumn>
  )
}
