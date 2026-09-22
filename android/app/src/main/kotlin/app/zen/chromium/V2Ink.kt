package app.zen.chromium

import android.content.Context
import android.graphics.drawable.Drawable
import androidx.annotation.ColorInt
import androidx.annotation.DrawableRes
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.drawable.DrawableCompat

/**
 * The v2 token block of the theme in force (design language v2 §1, main.css's `--v2-*` block),
 * for what the app draws natively. The colours are the `v2_*` resources of `colors.xml`, which
 * `V2TokensPinTest` holds equal to the stylesheet's values for both themes, so a native surface
 * reads the chrome's tokens and never a number of its own; the alphas a token derives from the
 * text ink (the deemphasised ink, the fills, the grabber, a checkbox's edge) are derived here
 * the same way, from the one ink, at [PromptSheetSpec]'s pinned fractions.
 *
 * The accent pair may be the chrome's live theme (`chrome.setTheme` hands `--v2-accent` and
 * `--v2-on-accent` over as the space's colour changes); without it the resources stand in,
 * which are the tokens under the default accent.
 */
class V2Ink(
    private val context: Context,
    /** Whether the dark token block is in force. */
    val dark: Boolean,
    accent: Int? = null,
    onAccent: Int? = null
) {
    private fun color(light: Int, dark: Int): Int = ContextCompat.getColor(context, if (this.dark) dark else light)

    /** `--v2-page`: a field's surface. */
    @ColorInt val page: Int = color(R.color.v2_page_light, R.color.v2_page_dark)
    /** `--v2-panel`: the sheet's fill (painted by the sheet's own style, read here for what sits on it). */
    @ColorInt val panel: Int = color(R.color.v2_panel_light, R.color.v2_panel_dark)
    /** `--v2-border`: the hairline. */
    @ColorInt val border: Int = color(R.color.v2_border_light, R.color.v2_border_dark)
    /** `--v2-text`: the ink. */
    @ColorInt val text: Int = color(R.color.v2_text_light, R.color.v2_text_dark)
    /** `--v2-text-deemphasized`: the ink at 69 %. */
    @ColorInt val textDeemphasized: Int = alpha(text, PromptSheetSpec.DEEMPHASIZED_ALPHA)
    /** `--v2-fill`: the ink at 10 %, a secondary button's fill. */
    @ColorInt val fill: Int = alpha(text, PromptSheetSpec.FILL_ALPHA)
    /** `--v2-fill-hover`: the ink at 16 %, the fill under a press. */
    @ColorInt val fillPressed: Int = alpha(text, PromptSheetSpec.FILL_PRESSED_ALPHA)
    /** The grabber (§9.9): the ink at 25 %. */
    @ColorInt val grabber: Int = alpha(text, PromptSheetSpec.GRABBER_ALPHA)
    /** A checkbox's edge at rest (§9.14): the ink at 30 %. */
    @ColorInt val checkboxBorder: Int = alpha(text, PromptSheetSpec.CHECKBOX_BORDER_ALPHA)
    /** `--v2-accent`: the primary button's fill, a ticked checkbox, a focused field's edge. */
    @ColorInt val accent: Int = accent ?: color(R.color.v2_accent_light, R.color.v2_accent_dark)
    /** `--v2-on-accent`: what is drawn on the accent. */
    @ColorInt val onAccent: Int = onAccent ?: color(R.color.v2_on_accent_light, R.color.v2_on_accent_dark)
    /** `--v2-danger`: a destructive peer's label (Exit page, Remove). */
    @ColorInt val danger: Int = color(R.color.v2_danger_light, R.color.v2_danger_dark)
    /** The accent under a press: `color-mix(in srgb, var(--v2-on-accent) 30%, var(--v2-accent))`. */
    @ColorInt val accentPressed: Int = ColorUtils.blendARGB(this.accent, this.onAccent, PromptSheetSpec.ACCENT_PRESSED_MIX)

    /** A vector glyph of the app's in the ink (a globe, a check), as a §9.23 title glyph is drawn. */
    fun glyph(@DrawableRes id: Int, @ColorInt tint: Int = text): Drawable =
        ContextCompat.getDrawable(context, id)!!.mutate().also { DrawableCompat.setTint(it, tint) }

    companion object {
        /** `color` at `fraction` of its alpha, rounded as the stylesheet's `rgb(r g b / a)` is. */
        @ColorInt fun alpha(@ColorInt color: Int, fraction: Float): Int =
            ColorUtils.setAlphaComponent(color, Math.round(fraction * 255))
    }
}
