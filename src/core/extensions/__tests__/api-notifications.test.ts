import { describe, expect, it } from 'vitest'
import {
  ERROR_EXTRA_IMAGE,
  ERROR_EXTRA_LIST_ITEMS,
  ERROR_ID_TOO_LONG,
  ERROR_INVALID_PROGRESS,
  ERROR_MISSING_REQUIRED,
  ERROR_UNEXPECTED_PROGRESS,
  MAX_BUTTONS,
  NOTIFICATION_ID_LENGTH_LIMIT,
  checkNotificationId,
  mergeNotificationOptions,
  normalizeNotificationOptions,
  toNativeNotification,
  type NotificationOptions
} from '../api/notifications'

const basic: NotificationOptions = {
  type: 'basic',
  iconUrl: 'icon.png',
  title: 'Hello',
  message: 'World'
}

describe('normalizeNotificationOptions', () => {
  it('requires type, iconUrl, title and message for create', () => {
    expect(normalizeNotificationOptions(basic, true)).toEqual(basic)
    for (const key of ['type', 'iconUrl', 'title', 'message'] as const) {
      const partial: Record<string, unknown> = { ...basic }
      delete partial[key]
      expect(() => normalizeNotificationOptions(partial, true)).toThrow(ERROR_MISSING_REQUIRED)
    }
    // Everything is optional for update.
    expect(normalizeNotificationOptions({ message: 'later' }, false)).toEqual({ message: 'later' })
    expect(() => normalizeNotificationOptions(null, false)).toThrow(/Invalid options/)
  })

  it('validates field types, the priority range and caps the buttons', () => {
    expect(() => normalizeNotificationOptions({ ...basic, type: 'toast' }, true)).toThrow(
      /Invalid value for 'type'/
    )
    expect(() => normalizeNotificationOptions({ ...basic, title: 1 }, true)).toThrow(
      /Invalid value for 'title'/
    )
    expect(() => normalizeNotificationOptions({ ...basic, priority: 3 }, true)).toThrow(
      /Invalid value for 'priority'/
    )
    expect(() => normalizeNotificationOptions({ ...basic, priority: 1.5 }, true)).toThrow(
      /Invalid value for 'priority'/
    )
    expect(normalizeNotificationOptions({ ...basic, priority: -2 }, true).priority).toBe(-2)
    expect(() => normalizeNotificationOptions({ ...basic, buttons: 'x' }, true)).toThrow(
      /Invalid value for 'buttons'/
    )
    expect(() => normalizeNotificationOptions({ ...basic, buttons: [{}] }, true)).toThrow(
      /Invalid value for 'buttons'/
    )
    const many = normalizeNotificationOptions(
      { ...basic, buttons: [{ title: 'a', iconUrl: 'a.png' }, { title: 'b' }, { title: 'c' }] },
      true
    )
    expect(many.buttons).toHaveLength(MAX_BUTTONS)
    expect(many.buttons?.[0]).toEqual({ title: 'a', iconUrl: 'a.png' })
    expect(() => normalizeNotificationOptions({ ...basic, silent: 'yes' }, true)).toThrow(
      /Invalid value for 'silent'/
    )
    expect(() => normalizeNotificationOptions({ ...basic, eventTime: NaN }, true)).toThrow(
      /Invalid value for 'eventTime'/
    )
  })

  it('applies the type-specific rules on create', () => {
    expect(() => normalizeNotificationOptions({ ...basic, progress: 50 }, true)).toThrow(
      ERROR_UNEXPECTED_PROGRESS
    )
    expect(() =>
      normalizeNotificationOptions({ ...basic, type: 'progress', progress: 101 }, true)
    ).toThrow(ERROR_INVALID_PROGRESS)
    expect(
      normalizeNotificationOptions({ ...basic, type: 'progress', progress: 40 }, true).progress
    ).toBe(40)
    expect(() =>
      normalizeNotificationOptions({ ...basic, items: [{ title: 'a', message: 'b' }] }, true)
    ).toThrow(ERROR_EXTRA_LIST_ITEMS)
    expect(() => normalizeNotificationOptions({ ...basic, items: [{ title: 'a' }] }, true)).toThrow(
      /Invalid value for 'items'/
    )
    expect(() => normalizeNotificationOptions({ ...basic, imageUrl: 'big.png' }, true)).toThrow(
      ERROR_EXTRA_IMAGE
    )
    expect(
      normalizeNotificationOptions({ ...basic, type: 'image', imageUrl: 'big.png' }, true).imageUrl
    ).toBe('big.png')
  })

  it('merges an update into the current options and re-checks the result', () => {
    const current = normalizeNotificationOptions({ ...basic, type: 'progress', progress: 10 }, true)
    expect(mergeNotificationOptions(current, { progress: 90, title: 'Nearly' })).toMatchObject({
      progress: 90,
      title: 'Nearly',
      message: 'World'
    })
    expect(() => mergeNotificationOptions(current, { type: 'basic' })).toThrow(
      ERROR_UNEXPECTED_PROGRESS
    )
  })

  it('limits notification ids to 500 characters', () => {
    expect(() => checkNotificationId('x'.repeat(NOTIFICATION_ID_LENGTH_LIMIT))).not.toThrow()
    expect(() => checkNotificationId('x'.repeat(NOTIFICATION_ID_LENGTH_LIMIT + 1))).toThrow(
      ERROR_ID_TOO_LONG
    )
  })
})

describe('toNativeNotification', () => {
  it('flattens list items and progress into body lines', () => {
    const list = toNativeNotification(
      {
        ...basic,
        type: 'list',
        items: [
          { title: 'One', message: 'first' },
          { title: 'Two', message: '' }
        ]
      },
      false
    )
    expect(list.body).toBe('World\nOne: first\nTwo')
    const progress = toNativeNotification({ ...basic, type: 'progress', progress: 66.6 }, false)
    expect(progress.body).toBe('World\n67%')
  })

  it('puts contextMessage in the subtitle where one exists, else as the last body line', () => {
    const withSubtitle = toNativeNotification({ ...basic, contextMessage: 'ctx' }, true)
    expect(withSubtitle.subtitle).toBe('ctx')
    expect(withSubtitle.body).toBe('World')
    const withoutSubtitle = toNativeNotification({ ...basic, contextMessage: 'ctx' }, false)
    expect(withoutSubtitle.subtitle).toBe('')
    expect(withoutSubtitle.body).toBe('World\nctx')
  })

  it('derives urgency and requireInteraction from the priority', () => {
    expect(toNativeNotification(basic, false)).toMatchObject({
      title: 'Hello',
      iconUrl: 'icon.png',
      silent: false,
      requireInteraction: false,
      urgency: 'normal',
      buttons: []
    })
    expect(toNativeNotification({ ...basic, priority: 2 }, false)).toMatchObject({
      urgency: 'critical',
      requireInteraction: true
    })
    expect(toNativeNotification({ ...basic, priority: -1 }, false).urgency).toBe('low')
    expect(
      toNativeNotification({ ...basic, priority: 2, requireInteraction: false }, false)
        .requireInteraction
    ).toBe(false)
    expect(
      toNativeNotification(
        { ...basic, buttons: [{ title: 'Yes' }, { title: 'No' }], silent: true },
        false
      )
    ).toMatchObject({ buttons: ['Yes', 'No'], silent: true })
  })
})
