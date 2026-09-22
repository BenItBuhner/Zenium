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
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.widget.ImageViewCompat
import androidx.core.widget.TextViewCompat
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * "This page isn't responding" (ERR-16 / OS-36): the v2 prompt sheet (§9.23) drawn natively,
 * because the chrome that would draw it runs in the very renderer that has stopped answering.
 * Grip strip, then the title block with the site as its identity – its favicon at 20 (a globe
 * for a page without one) on the title's start with the 8 gap, the host at 17/600 on 22, the
 * sentence as the 15 description at 69 % on 20, 4 under it – then 16 to the §9.11 footer: Wait
 * and Exit page splitting the width at 8, 40 tall, Exit page in the danger ink on the trailing
 * side. A dismissal by the scrim or back is Wait, the answer that changes nothing.
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
    private val ink = ContextCompat.getColor(context, if (dark) R.color.v2_text_dark else R.color.v2_text_light)
    private val inkFaint = ColorUtils.setAlphaComponent(ink, (0.69f * 255).toInt())
    private val hairline = ContextCompat.getColor(context, if (dark) R.color.v2_border_dark else R.color.v2_border_light)
    private val danger = ContextCompat.getColor(context, if (dark) R.color.v2_danger_dark else R.color.v2_danger_light)
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

    private fun content(dialog: BottomSheetDialog): View {
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = edge()
            setPadding(0, dp(8), 0, dp(16))
        }
        column.addView(grabber(), LinearLayout.LayoutParams(dp(32), dp(4)).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            bottomMargin = dp(8)
        })
        column.addView(titleBlock())
        column.addView(footer(dialog), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(CONTROL_DP)).apply {
            topMargin = dp(16)
            marginStart = dp(16)
            marginEnd = dp(16)
        })
        return column
    }

    /** The title block (§9.23): identity row, then the description 4 under it; padding 16, no bottom of its own (the footer's 16 follows). */
    private fun titleBlock(): View {
        val block = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), 0)
        }
        val identity = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val glyph = ImageView(context).apply {
            if (favicon != null) setImageBitmap(favicon) else {
                setImageResource(R.drawable.ic_globe)
                ImageViewCompat.setImageTintList(this, ColorStateList.valueOf(ink))
            }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        identity.addView(glyph, LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginEnd = dp(8) })
        val title = TextView(context).apply {
            text = site
            setTextColor(ink)
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
            setTextColor(inkFaint)
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
        row.addView(button(context.getString(R.string.unresponsive_wait), ink) {
            answered = true
            dialog.dismiss()
            onWait()
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply { marginEnd = dp(4) })
        row.addView(button(context.getString(R.string.unresponsive_exit), danger) {
            answered = true
            dialog.dismiss()
            onExit()
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply { marginStart = dp(4) })
        return row
    }

    /** `.zen-v2-button` as a view: the 10 % ink fill at radius 6, the label 15/500 in `color`, the press as the hover fill. */
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
        setPadding(dp(16), 0, dp(16), 0)
        setOnClickListener { onClick() }
    }

    private fun buttonFill(): RippleDrawable {
        val radius = dp(6).toFloat()
        val fill = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = radius
            setColor(ColorUtils.setAlphaComponent(ink, (0.10f * 255).toInt()))
        }
        val mask = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = radius
            setColor(Color.WHITE)
        }
        // The press lands the fill on the hover step (16 %): 6 % of ink over the 10 % at rest.
        return RippleDrawable(ColorStateList.valueOf(ColorUtils.setAlphaComponent(ink, (0.06f * 255).toInt())), fill, mask)
    }

    /** The 1 px border of the sheet, over the panel colour the sheet style paints. */
    private fun edge(): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        val r = dp(12).toFloat()
        cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
        setColor(Color.TRANSPARENT)
        setStroke(1, hairline)
    }

    private fun grabber(): View = View(context).apply {
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(2).toFloat()
            setColor(ColorUtils.setAlphaComponent(ink, (0.3f * 255).toInt()))
        }
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
