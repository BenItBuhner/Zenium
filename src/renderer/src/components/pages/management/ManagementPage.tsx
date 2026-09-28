import { useEffect, useState, type JSX } from 'react'
import {
  MANAGED_KEYS_HEADING,
  MANAGEMENT_PAGE_TITLE,
  isManaged,
  managedStatusOf,
  managementHeading,
  managementNotice,
  unmanaged,
  type ManagedStatus
} from '@shared/managed'
import { cmd } from '@renderer/lib/api'
import { PageColumn, PageGroup, PageTitleBlock } from '../PageFrame'
import { Prose } from '../about/Prose'

/**
 * The Management page (`zen://management`, TB-13; Chrome's chrome://management, from the app
 * menu's "Managed Browser" row): a chrome page tab on the shared page frame. The title block
 * is "Management" (Chrome for Android's `IDS_MANAGEMENT`) with Chrome's page subtitle 15 at 69%
 * under it – "Your browser is managed by your organization", the organisation's name in place
 * of the phrase when the bundle's `EnterpriseCustomLabel` gives one, "Your browser is not
 * managed" otherwise (`components/management_strings.grdp`) – over the notice Chrome's
 * `overview-section` carries, then, for a managed browser, the bundle's keys as one group of
 * static rows (§9.34: text, not targets) under a heading with their count: what the
 * administrator configured, which Zenium reads and does not yet apply, as the notice says.
 * The status is asked of the core on mount (`managed.status`: the one read the app menu's
 * first build made, or the read the page's own mount makes when the menu never opened), so
 * nothing about it lives in the window's state.
 */
export function ManagementPage(): JSX.Element {
  const [status, setStatus] = useState<ManagedStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    void cmd('managed.status', undefined)
      .then((value) => {
        if (!cancelled) setStatus(managedStatusOf(value))
      })
      .catch(() => {
        if (!cancelled) setStatus(unmanaged())
      })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <PageColumn
      testId="management-page"
      header={
        <PageTitleBlock
          title={MANAGEMENT_PAGE_TITLE}
          titleId="management-title"
          description={status ? managementHeading(status) : undefined}
        />
      }
    >
      {status && (
        <>
          <Prose text={managementNotice(status)} testId="management-notice" />
          {isManaged(status) && (
            <PageGroup
              heading={MANAGED_KEYS_HEADING}
              headingId="zen-management-keys"
              aside={status.keys.length}
              data-testid="management-keys"
            >
              <ul className="zen-page-rows" aria-labelledby="zen-management-keys">
                {status.keys.map((key) => (
                  <li key={key}>
                    <div
                      className="zen-v2-row zen-page-row"
                      data-static=""
                      data-testid="management-key"
                    >
                      <span className="zen-page-row-text">
                        <span className="zen-page-row-label">{key}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </PageGroup>
          )}
        </>
      )}
    </PageColumn>
  )
}
