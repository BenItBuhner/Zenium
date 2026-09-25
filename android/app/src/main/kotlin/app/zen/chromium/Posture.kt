package app.zen.chromium

import android.app.Activity
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.util.Consumer
import androidx.window.java.layout.WindowInfoTrackerCallbackAdapter
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import org.json.JSONObject

/**
 * A foldable's posture for the chrome (OS-11 / TABLET-08): `androidx.window`'s layout info –
 * the window's [FoldingFeature], when the window lies across a fold – as the `posture` host
 * event, `{ kind: "flat" | "halfOpened", hinge: { left, top, right, bottom, orientation,
 * separating } | null }` with the hinge's bounds in CSS px in the window's coordinates, the way
 * the insets are told ([MainActivity.applyInsets]). The chrome logs the pose and marks its root;
 * it lays itself out by the window's width, not the pose (no tabletop layout), so a fold that
 * moves the pose moves the layout through the resize it brings (`configChanges` keeps the
 * WebViews). Reported at boot ([current], the boot payload's `posture`) and then on a change
 * alone, on the main thread; a device without a fold reports nothing after the boot's `flat`.
 *
 * The report's shape is [Report], free of Android types for JUnit; the tracker's listener is
 * added with the window ([start], `onStart`) and removed as it leaves the screen ([stop]).
 */
class Posture(private val activity: Activity, private val onChange: (JSONObject) -> Unit) {
    private val tracker = WindowInfoTrackerCallbackAdapter(WindowInfoTracker.getOrCreate(activity))
    private var current: JSONObject = Report.flat()
    private var listening = false
    private val listener = Consumer<WindowLayoutInfo> { info -> onLayout(info) }

    /** The posture as last reported (flat until the first layout info arrives). */
    fun current(): JSONObject = current

    /** Listen for the window's layout; the first change after this reaches [onChange]. Idempotent. */
    fun start() {
        if (listening) return
        listening = true
        runCatching {
            tracker.addWindowLayoutInfoListener(activity, ContextCompat.getMainExecutor(activity), listener)
        }.onFailure {
            listening = false
            Log.w(TAG, "posture: window layout info unavailable", it)
        }
    }

    fun stop() {
        if (!listening) return
        listening = false
        runCatching { tracker.removeWindowLayoutInfoListener(listener) }
    }

    private fun onLayout(info: WindowLayoutInfo) {
        val fold = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull()
        val next = if (fold == null) {
            Report.flat()
        } else {
            Report.describe(
                halfOpened = fold.state == FoldingFeature.State.HALF_OPENED,
                horizontal = fold.orientation == FoldingFeature.Orientation.HORIZONTAL,
                left = fold.bounds.left,
                top = fold.bounds.top,
                right = fold.bounds.right,
                bottom = fold.bounds.bottom,
                separating = fold.isSeparating,
                density = activity.resources.displayMetrics.density
            )
        }
        if (Report.same(current, next)) return
        current = next
        Log.i(TAG, "posture ${Report.line(next)}")
        onChange(next)
    }

    /** The `posture` payload: pure, for the JVM tests. */
    object Report {
        const val FLAT = "flat"
        const val HALF_OPENED = "halfOpened"

        /** No fold in this window: a slab, or a foldable whose window lies on one side of the fold. */
        fun flat(): JSONObject = json("kind" to FLAT, "hinge" to null)

        /**
         * A fold across the window: its state as the kind, its bounds (window px) in CSS px by
         * `density`, its orientation and whether it separates the two halves.
         */
        fun describe(
            halfOpened: Boolean,
            horizontal: Boolean,
            left: Int,
            top: Int,
            right: Int,
            bottom: Int,
            separating: Boolean,
            density: Float
        ): JSONObject {
            val d = density.toDouble().takeIf { it > 0 } ?: 1.0
            return json(
                "kind" to if (halfOpened) HALF_OPENED else FLAT,
                "hinge" to json(
                    "left" to left / d,
                    "top" to top / d,
                    "right" to right / d,
                    "bottom" to bottom / d,
                    "orientation" to if (horizontal) "horizontal" else "vertical",
                    "separating" to separating
                )
            )
        }

        /** Two reports name the same pose and hinge: nothing is sent for a repeat. */
        fun same(a: JSONObject, b: JSONObject): Boolean {
            if (a.str("kind") != b.str("kind")) return false
            val ha = a.optJSONObject("hinge")
            val hb = b.optJSONObject("hinge")
            if (ha == null || hb == null) return ha == null && hb == null
            return ha.optDouble("left") == hb.optDouble("left") &&
                ha.optDouble("top") == hb.optDouble("top") &&
                ha.optDouble("right") == hb.optDouble("right") &&
                ha.optDouble("bottom") == hb.optDouble("bottom") &&
                ha.str("orientation") == hb.str("orientation") &&
                ha.optBoolean("separating") == hb.optBoolean("separating")
        }

        /** The report in one line for the log: the pose, then the hinge's orientation and place. */
        fun line(report: JSONObject): String {
            val kind = report.str("kind")
            val hinge = report.optJSONObject("hinge") ?: return kind
            val orientation = hinge.str("orientation")
            val place = if (orientation == "horizontal") {
                "${hinge.optDouble("bottom") - hinge.optDouble("top")} tall at y ${hinge.optDouble("top")}"
            } else {
                "${hinge.optDouble("right") - hinge.optDouble("left")} wide at x ${hinge.optDouble("left")}"
            }
            val separating = if (hinge.optBoolean("separating")) ", separating" else ""
            return "$kind, $orientation hinge $place$separating"
        }
    }

    private companion object {
        const val TAG = "ZenPosture"
    }
}
