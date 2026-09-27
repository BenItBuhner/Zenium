package app.zen.chromium

import android.os.Build
import android.view.MotionEvent

/**
 * Whether this touch (a down) opens a touchpad's two-finger swipe rather than a finger's touch.
 * From Android 14 the platform hands a view the swipe as one fake finger it classifies
 * (`GestureConverter.cpp`, `handleScroll`: `SOURCE_MOUSE`, `TOOL_TYPE_FINGER`,
 * `CLASSIFICATION_TWO_FINGER_SWIPE`), so it rides the touch pipeline; the test is
 * [HistoryNavClassifier.isTouchpadSwipe] on the event's buttons and – from API 29, where it
 * exists – its classification (before that nothing is classified, and no touch is the swipe).
 *
 * The gestures that tell the swipe from a finger read it here, at the same down: the overscroll
 * history navigation arms on it from anywhere (GN-23), the pull-to-refresh never does (GN-05,
 * Chrome's touchscreen-only refresh).
 */
internal fun MotionEvent.isTouchpadSwipe(): Boolean {
    val classification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) classification else HistoryNavClassifier.CLASSIFICATION_NONE
    return HistoryNavClassifier.isTouchpadSwipe(buttonState, classification)
}
