import type { FormFieldKind, FormGroup, Rect } from './types'

/**
 * The protocol between the in-page forms script (`formsScript.ts`) and the browser's autofill
 * service. Events go up on the page-message channel as `{ type: 'forms', forms: FormsEvent }`;
 * commands come down through the host (`TabView.sendFormsCommand`).
 */

/** One classified field of the focused form, so the browser knows what a fill can target. */
export interface FormFieldInfo {
  id: string
  kind: FormFieldKind
  hasValue: boolean
}

/**
 * Values keyed by field kind, as a fill hands them down or a submit hands them up. A `<select>`
 * reports `value|label` (`US|United States`) so the browser can resolve either spelling.
 */
export type FormValues = Partial<Record<FormFieldKind, string>>

export type FormsEvent =
  /** A classified field gained focus; `rect` is in visual-viewport CSS pixels. */
  | {
      type: 'focus'
      group: FormGroup
      formId: string
      fieldId: string
      kind: FormFieldKind
      rect: Rect
      hasValue: boolean
      fields: FormFieldInfo[]
    }
  /** The focused field moved (the page scrolled or re-laid out). */
  | { type: 'moved'; fieldId: string; rect: Rect }
  | { type: 'blur' }
  /**
   * A form was submitted (a `submit` event, a click on its submit button, or Enter in one of its
   * fields). `newPassword` marks sign-up and change-password forms; `values` holds the address or
   * card fields of the other groups.
   */
  | { type: 'submit'; group: 'login'; formId: string; username: string; password: string; newPassword: boolean }
  | { type: 'submit'; group: 'address' | 'card'; formId: string; values: FormValues }
  /**
   * The submitted form left the page without a navigation (a single-page app signed the user
   * in), so a provisional save candidate can be confirmed.
   */
  | { type: 'settled'; formId: string }
  /** The page created or used a passkey (`navigator.credentials` with `publicKey`). */
  | {
      type: 'passkey'
      op: 'create' | 'get'
      rpId: string
      rpName: string
      userName: string
      userDisplayName: string
      credentialId: string
    }

export type FormsCommand =
  /**
   * Put `values` into the fields of `formId` (or, with `fieldId`, only into that one field).
   * `labels` carries the display names a `<select>` may use instead of the codes in `values`.
   */
  | {
      type: 'fill'
      formId: string
      fieldId?: string
      values: FormValues
      labels?: { countryName?: string; regionName?: string }
    }
  /** Whether the script should report anything at all (off when every autofill setting is off). */
  | { type: 'config'; enabled: boolean }

/** Which vault section each field kind belongs to. */
export function groupOfKind(kind: FormFieldKind): FormGroup {
  switch (kind) {
    case 'username':
    case 'password':
    case 'new-password':
    case 'one-time-code':
      return 'login'
    case 'cc-name':
    case 'cc-number':
    case 'cc-exp':
    case 'cc-exp-month':
    case 'cc-exp-year':
    case 'cc-csc':
      return 'card'
    default:
      return 'address'
  }
}

/** Field kinds a fill may write; the security code is typed by the user every time. */
export const FILLABLE_KINDS: ReadonlySet<FormFieldKind> = new Set<FormFieldKind>([
  'username',
  'password',
  'new-password',
  'name',
  'given-name',
  'family-name',
  'organization',
  'street-address',
  'address-line1',
  'address-line2',
  'address-level1',
  'address-level2',
  'postal-code',
  'country',
  'tel',
  'email',
  'cc-name',
  'cc-number',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year'
])
