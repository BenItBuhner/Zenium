package app.zen.chromium

import kotlin.math.roundToInt

/**
 * The strips along a tab view's top and bottom edges that chrome messages (toasts, banners) draw
 * over. The page is layered above the chrome, so it is clipped out of the strips and touches
 * there go to the chrome underneath; the clip springs to each new value the way the card does
 * in the chrome (`useMessageMotion`), so the page's edge and the card move together.
 *
 * A capture that copies the page's whole frame out of the window ([PageCapture]) can [hold] the
 * cover: the strips stand at 0 – the page draws over whatever message lies under it – while the
 * targets keep following the chrome, and [release] puts the strips back at them.
 */
class ContentCover(private val density: () -> Float, private val onChange: () -> Unit) {
    /** Current strips in CSS px (the animated values). */
    var top = 0f
        private set
    var bottom = 0f
        private set
    /** Targets in CSS px. */
    var topTarget = 0f
        private set
    var bottomTarget = 0f
        private set
    /** Held at 0 for a capture; the targets wait for the release. */
    var held = false
        private set

    private val topSpring = Spring(STIFFNESS, DAMPING, { top = it; onChange() }, { top = it; onChange() })
    private val bottomSpring = Spring(STIFFNESS, DAMPING, { bottom = it; onChange() }, { bottom = it; onChange() })

    val topPx: Int get() = (top * density()).roundToInt().coerceAtLeast(0)
    val bottomPx: Int get() = (bottom * density()).roundToInt().coerceAtLeast(0)
    /** A strip stands or is on its way: the page is clipped and the strips' touches are the chrome's. */
    val active: Boolean get() = !held && (top > 0f || bottom > 0f || topTarget > 0f || bottomTarget > 0f)

    /** Aim the strips at `topCss` / `bottomCss`; `snap` puts them there at once. */
    fun set(topCss: Float, bottomCss: Float, snap: Boolean = false) {
        val t = topCss.coerceAtLeast(0f)
        val b = bottomCss.coerceAtLeast(0f)
        if (t == topTarget && b == bottomTarget && !snap) return
        topTarget = t
        bottomTarget = b
        // Under a hold the strips stay at 0; the release puts them where the chrome last asked.
        if (held) return
        if (snap) {
            topSpring.stop()
            bottomSpring.stop()
            top = t
            bottom = b
            onChange()
            return
        }
        // A retarget mid-flight starts again from where the strip is (the spring keeps no
        // velocity to hand over); cover changes are rare enough for that not to show.
        if (top != t) topSpring.animate(top, 0f, t) else topSpring.stop()
        if (bottom != b) bottomSpring.animate(bottom, 0f, b) else bottomSpring.stop()
    }

    /**
     * Put the strips at 0 and keep them there: the page covers its whole frame, so a copy of the
     * frame is the page and nothing of a message drawn under it (a banner that stays – default
     * browser, add to home screen – would otherwise be stitched into every strip of a long
     * capture). The targets go on taking the chrome's values for the release.
     */
    fun hold() {
        if (held) return
        held = true
        topSpring.stop()
        bottomSpring.stop()
        top = 0f
        bottom = 0f
        onChange()
    }

    /**
     * The capture is over: the strips go back to the targets at once, as the page itself is put
     * back where it was (a snap, not a spring – everything the capture moved returns together).
     */
    fun release() {
        if (!held) return
        held = false
        top = topTarget
        bottom = bottomTarget
        onChange()
    }

    /** Stop everything (the view is going away). */
    fun reset() {
        topSpring.stop()
        bottomSpring.stop()
        held = false
        top = 0f
        bottom = 0f
        topTarget = 0f
        bottomTarget = 0f
    }

    private companion object {
        // `SPRING_GENTLE` in the chrome: the arrival of a card.
        const val STIFFNESS = 300f
        const val DAMPING = 31f
    }
}
