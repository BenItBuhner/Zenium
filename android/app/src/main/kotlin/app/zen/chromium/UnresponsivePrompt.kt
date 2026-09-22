package app.zen.chromium

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.widget.ImageViewCompat
import androidx.core.widget.TextViewCompat
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * "This page isn't responding" (ERR-16 / OS-36): the v2 prompt sheet (§9.23) drawn natively,
 * because the chrome that would draw it runs in the very renderer that has stopped answering.
 * It is the one chrome surface the app imitates with Android views (§9.23 closes the route:
 * nothing else the chrome draws takes it), and the imitation is held to the sheet's numbers and
 * the theme's inks exactly.
 *
 * The composition is the chassis's (`.zen-sheet` and `PhoneSheet`'s block pose in `main.css`),
 * number for number: the panel (`--v2-panel`) edge to edge at the bottom with its 12 top radii
 * and the 1 px hairline (`--v2-border`), under the navigation bar with the bar's inset as its
 * padding (Material's edge-to-edge sheet, as the chassis pads `max(8, inset)`); the 20 grip strip
 * – the 32 × 4 grabber 8 from the top in the text at 25 % (`.zen-sheet-handle`), its 96 × 44 hit
 * overlapping the block by 24 as `.zen-sheet-handle-hit` does, a tap on it Wait (one detent,
 * nothing to resize); the title block padded 16 with the site as its identity – its favicon at
 * 20 (a globe for a page without one) on the title's start with the 8 gap, the host at 17/600 on
 * 22, the sentence as the 15 description at 69 % on 20, 4 under it, 16 to the footer; the §9.11
 * footer: Wait and Exit page splitting the width at 8 with 16 gutters, `--v2-control` (40) tall
 * at radius 6 on the text's 10 % fill, the label 15/500, Exit page in the danger ink on the
 * trailing side, no primary; the one scrim, black at `--v2-scrim`'s .4 / .55; the system font.
 * Every ink is [V2Tokens]', generated from `main.css`'s token block and pinned to it by
 * `V2TokensTest` – no colour is retyped here.
 *
 * Different by allowance, motion alone: the sheet fades 120 ms in and out (§11.3's reduced-motion
 * form) in place of the chassis's spring, the page beneath does not recede (its WebView is the
 * hung renderer's) and stands still under the scrim, and the sheet does not drag. A dismissal by
 * the scrim or the system back is Wait, the answer that changes nothing.
 */
class UnresponsivePrompt(
    private val context: Context,
    private val dark: Boolean,
    private val site: String,
    private val favicon: Bitmap?,
    private val onWait: () -> Unit,
    private val onExit: () -> Unit
) {
    private val density = context.resources.displayMetrics.density
    /** The theme in force's inks, as the chrome's stylesheet declares them. */
    private val tokens = V2Tokens.of(dark)
    private var dialog: BottomSheetDialog? = null
    private var answered = false

    val showing: Boolean get() = dialog != null

    fun show() {
        if (dialog != null) return
        val dialog = BottomSheetDialog(context, if (dark) R.style.ThemeOverlay_Zen_Sheet_Dark else R.style.ThemeOverlay_Zen_Sheet)
        dialog.setContentView(content(dialog))
        // The window's name for TalkBack is the site's, as the sheet's title is.
        dialog.setTitle(site)
        dialog.behavior.skipCollapsed = true
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        // No drag: the sheet has one detent and its answers are its two buttons (and Wait by the scrim or back).
        dialog.behavior.isDraggable = false
        dialog.window?.let { window ->
            // The scrim: black at the token block's alpha (.4 / .55), the one dim the window paints.
            window.setDimAmount(tokens.scrimAlpha)
            // The 120 ms fade in and out in place of the chassis's spring (§11.3's form).
            window.setWindowAnimations(R.style.Animation_Zen_UnresponsivePrompt)
        }
        // The panel fill under the whole sheet, the navigation bar's inset included, from the table.
        dialog.findViewById<View>(com.google.android.material.R.id.design_bottom_sheet)
            ?.backgroundTintList = ColorStateList.valueOf(tokens.panel)
        dialog.setOnDismissListener {
            if (this.dialog !== dialog) return@setOnDismissListener
            this.dialog = null
            if (!answered) {
                answered = true
                onWait()
            }
        }
        this.dialog = dialog
        dialog.show()
    }

    /** Take the sheet down without an answer (the renderer answered again, or went). */
    fun dismiss() {
        val d = dialog ?: return
        answered = true
        dialog = null
        d.dismiss()
    }

    /**
     * The column: grip, block, footer; the footer's 8 under the buttons is the column's bottom
     * padding, and the navigation bar's inset is the sheet's own (`paddingBottomSystemWindowInsets`
     * in the sheet's style), the panel running under the bar as the chassis's does.
     */
    private fun content(dialog: BottomSheetDialog): View {
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = edge()
            setPadding(0, 0, 0, dp(8))
        }
        column.addView(grip {
            answered = true
            dialog.dismiss()
            onWait()
        }, LinearLayout.LayoutParams(dp(96), dp(44)).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            // The hit's lower half lies over the block (`.zen-sheet-handle-hit`'s margin -24).
            bottomMargin = -dp(24)
        })
        column.addView(titleBlock())
        column.addView(footer(dialog), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(CONTROL_DP)).apply {
            topMargin = dp(16)
            marginStart = dp(16)
            marginEnd = dp(16)
        })
        return column
    }

    /** The title block (§9.23): identity row, then the description 4 under it; padded 16 on every side (the footer's 16 follows its 16). */
    private fun titleBlock(): View {
        val block = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        val identity = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val glyph = ImageView(context).apply {
            if (favicon != null) setImageBitmap(favicon) else {
                setImageResource(R.drawable.ic_globe)
                ImageViewCompat.setImageTintList(this, ColorStateList.valueOf(tokens.text))
            }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        identity.addView(glyph, LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginEnd = dp(8) })
        val title = TextView(context).apply {
            text = site
            setTextColor(tokens.text)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            typeface = weight(600)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            TextViewCompat.setLineHeight(this, sp(22))
        }
        ViewCompat.setAccessibilityHeading(title, true)
        identity.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        block.addView(identity, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val description = TextView(context).apply {
            text = context.getString(R.string.unresponsive_description)
            setTextColor(tokens.textDeemphasized)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            TextViewCompat.setLineHeight(this, sp(20))
        }
        block.addView(description, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(4)
        })
        return block
    }

    /** The §9.11 footer: two peers splitting the width at 8, the destructive one trailing in the danger ink. */
    private fun footer(dialog: BottomSheetDialog): View {
        val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(button(context.getString(R.string.unresponsive_wait), tokens.text) {
            answered = true
            dialog.dismiss()
            onWait()
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply { marginEnd = dp(4) })
        row.addView(button(context.getString(R.string.unresponsive_exit), tokens.danger) {
            answered = true
            dialog.dismiss()
            onExit()
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply { marginStart = dp(4) })
        return row
    }

    /** `.zen-v2-button` as a view: the 10 % ink fill at radius 6, `--v2-control` tall and 96 wide at least, padded 16, the label 15/500 in `color`, the press as the hover fill. */
    private fun button(label: String, color: Int, onClick: () -> Unit): View = TextView(context).apply {
        text = label
        setTextColor(color)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        typeface = weight(500)
        gravity = Gravity.CENTER
        maxLines = 1
        background = buttonFill()
        isClickable = true
        isFocusable = true
        minimumHeight = dp(CONTROL_DP)
        minimumWidth = dp(96)
        setPadding(dp(16), 0, dp(16), 0)
        setOnClickListener { onClick() }
    }

    private fun buttonFill(): RippleDrawable {
        val radius = dp(6).toFloat()
        val fill = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = radius
            setColor(tokens.fill)
        }
        val mask = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = radius
            setColor(Color.WHITE)
        }
        // The press lands the fill on the hover step (`--v2-fill-hover`, 16 %): the step from the
        // 10 % at rest is what the ripple adds over it.
        val step = Color.alpha(tokens.fillHover) - Color.alpha(tokens.fill)
        return RippleDrawable(ColorStateList.valueOf(ColorUtils.setAlphaComponent(tokens.text, step)), fill, mask)
    }

    /** The chassis's 1 px (one CSS px: a dp) hairline of the sheet, over the panel fill the sheet paints under the whole column. */
    private fun edge(): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        val r = dp(12).toFloat()
        cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
        setColor(Color.TRANSPARENT)
        setStroke(dp(1), tokens.border)
    }

    /**
     * The grip (`.zen-sheet-handle-hit` with its `.zen-sheet-handle`): the 96 × 44 target, its
     * 32 × 4 handle 8 from the top in the text at the chassis's alpha, named for TalkBack; a tap
     * is the one-detent sheet's dismissal, Wait.
     */
    private fun grip(onTap: () -> Unit): View = FrameLayout(context).apply {
        contentDescription = context.getString(R.string.unresponsive_dismiss)
        isClickable = true
        isFocusable = true
        setPadding(0, dp(8), 0, 0)
        setOnClickListener { onTap() }
        addView(View(context).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(2).toFloat()
                setColor(ColorUtils.setAlphaComponent(tokens.text, (V2Tokens.HANDLE_ALPHA * 255).toInt()))
            }
        }, FrameLayout.LayoutParams(dp(32), dp(4), Gravity.CENTER_HORIZONTAL or Gravity.TOP))
    }

    /** The scale's weights (600 titles, 500 buttons); before API 28 the nearest named face. */
    private fun weight(w: Int): Typeface =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, w, false)
        else if (w >= 600) Typeface.DEFAULT_BOLD else Typeface.create("sans-serif-medium", Typeface.NORMAL)

    private fun dp(value: Int): Int = (value * density + 0.5f).toInt()

    private fun sp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value.toFloat(), context.resources.displayMetrics).toInt()

    companion object {
        /** `--v2-control` on the phone: 40. */
        const val CONTROL_DP = 40
    }
}
