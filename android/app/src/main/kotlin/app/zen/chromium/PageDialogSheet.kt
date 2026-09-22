package app.zen.chromium

import android.animation.ValueAnimator
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.drawable.DrawableCompat
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.core.widget.TextViewCompat
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * A page's dialog as Zenium's phone sheet (PUI-27, PUI-28): the v2 draft's §9.23 prompt sheet
 * drawn natively – see [PageDialogSpec] for why the chrome's own `PageDialog` cannot draw it here.
 *
 * The chassis is the phone sheet's: the panel surface with a hairline edge and 12 dp top corners,
 * the §9.9 grip strip, then the §9.23 title block – Chrome's title line ("example.com says",
 * "Leave site?") at the heading size, the page's message 4 below at the body size in the
 * deemphasised ink, as the page wrote it, its line breaks kept – a `prompt`'s §9.12 field in the
 * 16 gutter, prefilled with the page's default text and focused on a tap, never on its own (§9.22:
 * the keyboard would come up with the sheet), and, from the page's second dialog of the visit on,
 * Chrome's §9.14 check row "Don't let this page create more dialogs" at §9.12's 16 from the field.
 * The §9.11 footer is pinned under the body: Cancel and OK (Leave, Reload) as peers splitting the
 * width at an 8 gap, the primary trailing; an alert has OK alone. A long message scrolls in the
 * body; the sheet stands at most 40 dp under the status bar. The keyboard lifts the sheet.
 *
 * Answering: OK accepts (the prompt's text with it; the field's Done key is OK), Cancel cancels,
 * and the scrim, the back gesture and a drag down cancel too (an alert is dismissed either way).
 * The page behind recedes on the sheet's progress – scale .97, +6 dp corner radius, v2 §11 – and
 * comes back as the sheet goes, frame for frame on a drag; nothing under reduced motion (§11.3).
 * The chrome's bar stands dimmed under the sheet's scrim, inert with the rest of the window.
 */
class PageDialogSheet(
    private val host: PageHost,
    private val spec: PageDialogSpec,
    /** The page behind, for the recede; null for none (a custom tab's toolbar is not a page). */
    private val page: TabWebView?,
    /**
     * The answer, once: `accepted` with the prompt's `value` (null for every other kind) and
     * whether the check row was ticked. A dismissal is a cancel (an alert's is its dismissal).
     */
    private val onAnswer: (accepted: Boolean, value: String?, suppress: Boolean) -> Unit
) {
    private val activity = host.activity
    private val density = activity.resources.displayMetrics.density
    private val dark = host.themeDark
    private val ink = ContextCompat.getColor(activity, if (dark) R.color.v2_text_dark else R.color.v2_text_light)
    private val inkDeemphasized = ColorUtils.setAlphaComponent(ink, (0.69f * 255).toInt())
    private val hairline = ContextCompat.getColor(activity, if (dark) R.color.v2_border_dark else R.color.v2_border_light)
    private val pageColor = ContextCompat.getColor(activity, if (dark) R.color.v2_page_dark else R.color.v2_page_light)
    private val accent = host.themeAccent
    private val onAccent = host.themeOnAccent
    private val fill = ColorUtils.setAlphaComponent(ink, (0.10f * 255).toInt())
    private val fillPressed = ColorUtils.setAlphaComponent(ink, (0.16f * 255).toInt())

    val dialog = BottomSheetDialog(activity, if (dark) R.style.ThemeOverlay_Zen_Sheet_Dark else R.style.ThemeOverlay_Zen_Sheet)
    private var field: EditText? = null
    private var check: CheckBox? = null
    private var answered = false
    private var recede = 0f
    private var recedeAnimator: ValueAnimator? = null
    /** Whether motion runs at all: the system's animator scale at 0 is the phone's reduced motion (§11.3). */
    private val motion = ValueAnimator.areAnimatorsEnabled()

    init {
        dialog.setContentView(content())
        dialog.setCanceledOnTouchOutside(true)
        dialog.dismissWithAnimation = motion
        dialog.behavior.skipCollapsed = true
        dialog.behavior.isFitToContents = true
        dialog.behavior.isHideable = true
        dialog.behavior.addBottomSheetCallback(object : BottomSheetBehavior.BottomSheetCallback() {
            override fun onStateChanged(bottomSheet: View, newState: Int) {}
            override fun onSlide(bottomSheet: View, slideOffset: Float) {
                // The sheet's progress from where it stands: the share of its height on screen.
                val parent = bottomSheet.parent as? View ?: return
                if (bottomSheet.height <= 0) return
                val shown = (parent.height - bottomSheet.top).toFloat() / bottomSheet.height
                recedeAnimator?.cancel()
                setRecede(shown.coerceIn(0f, 1f))
            }
        })
        // Before Android 11 the window itself makes room for the keyboard; from 11 on the
        // edge-to-edge dialog window is not resized for it, and the column pads (see content()).
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            @Suppress("DEPRECATION")
            dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        dialog.setOnDismissListener { answer(accepted = false, value = null) }
    }

    fun show() {
        dialog.show()
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        animateRecede(1f)
    }

    /** The page went (its view destroyed, its tab closed): the sheet goes without an answer of its own. */
    fun dismiss() {
        if (answered) return
        dialog.dismiss()
    }

    private fun accept() {
        answer(accepted = true, value = field?.text?.toString())
        // `cancel`, not `dismiss`: the sheet slides down (dismissWithAnimation), the page coming back with it.
        dialog.cancel()
    }

    private fun cancel() {
        answer(accepted = false, value = null)
        dialog.cancel()
    }

    private fun answer(accepted: Boolean, value: String?) {
        if (answered) return
        answered = true
        animateRecede(0f)
        onAnswer(accepted, if (accepted && spec.kind == PageDialogKind.PROMPT) value ?: "" else null, check?.isChecked == true)
    }

    // --- content ------------------------------------------------------------------------------

    private fun content(): View {
        val column = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            background = edge()
        }
        column.addView(grip(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(GRIP_DP)))
        val body = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        body.addView(titleBlock())
        if (spec.kind == PageDialogKind.PROMPT) body.addView(promptField(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(CONTROL_DP)).apply {
            marginStart = dp(16)
            marginEnd = dp(16)
        })
        if (spec.suppressible) body.addView(checkRow(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = if (spec.kind == PageDialogKind.PROMPT) dp(4) else 0
        })
        val scroller = MaxHeightScrollView(bodyMaxHeight()).apply {
            isVerticalScrollBarEnabled = false
            addView(body, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        column.addView(scroller, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        column.addView(footer())
        // The keyboard: an edge-to-edge dialog window is not resized for it (Android 11 on), so
        // the column pads for the part of it above the gesture bar, which the sheet pads for.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ViewCompat.setOnApplyWindowInsetsListener(column) { v, insets ->
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom
            v.setPadding(0, 0, 0, (ime - bars).coerceAtLeast(0))
            insets
        }
        return column
    }

    /** The 1 px border of the sheet, over the panel colour the sheet style paints. */
    private fun edge(): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        val r = dp(12).toFloat()
        cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
        setColor(Color.TRANSPARENT)
        setStroke(1, hairline)
    }

    /** §9.9: 32 × 4 at radius 2, ink at 25 %, 8 dp from the top edge, inside the 20 dp strip; a tap on it dismisses. */
    private fun grip(): View {
        val strip = FrameLayout(activity)
        val bar = View(activity).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(2).toFloat()
                setColor(ColorUtils.setAlphaComponent(ink, (0.25f * 255).toInt()))
            }
        }
        strip.addView(bar, FrameLayout.LayoutParams(dp(32), dp(4), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = dp(8) })
        strip.contentDescription = activity.getString(R.string.page_dialog_handle)
        strip.isClickable = true
        strip.isFocusable = true
        strip.setOnClickListener { cancel() }
        return strip
    }

    /**
     * §9.23: the title at the heading size, the description 4 below at the body size in the
     * deemphasised ink, both in the block's 16; the block keeps no bottom padding where the
     * footer follows it at its own 16 (an alert or confirm with no field and no check row).
     */
    private fun titleBlock(): View {
        val block = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val bottom = if (spec.kind == PageDialogKind.PROMPT || spec.suppressible) dp(16) else 0
            setPadding(dp(16), dp(16), dp(16), bottom)
        }
        val title = TextView(activity).apply {
            text = spec.title
            setTextColor(ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            typeface = weight(600)
            TextViewCompat.setLineHeight(this, sp(22))
            ViewCompat.setAccessibilityHeading(this, true)
        }
        block.addView(title)
        if (spec.message.isNotEmpty()) {
            val message = TextView(activity).apply {
                text = spec.message
                setTextColor(inkDeemphasized)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                TextViewCompat.setLineHeight(this, sp(20))
                breakStrategy = android.text.Layout.BREAK_STRATEGY_SIMPLE
            }
            block.addView(message, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
        }
        return block
    }

    /** §9.12: the page surface in a hairline box at the control radius, 12 in, the accent edge while focused. */
    private fun promptField(): View {
        val box = { edge: Int ->
            GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(CONTROL_RADIUS_DP).toFloat()
                setColor(pageColor)
                setStroke(1, edge)
            }
        }
        val background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), box(accent))
            addState(intArrayOf(), box(hairline))
        }
        return EditText(activity).apply {
            setText(spec.defaultValue)
            setSelectAllOnFocus(true)
            setTextColor(ink)
            setHintTextColor(inkDeemphasized)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            inputType = InputType.TYPE_CLASS_TEXT
            imeOptions = EditorInfo.IME_ACTION_DONE
            isSingleLine = true
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), 0, dp(12), 0)
            this.background = background
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_DONE) { accept(); true } else false
            }
            field = this
        }
    }

    /**
     * §9.14 / §6: the 20 box at radius 2 in a hairline of the ink at 30 % on the page surface,
     * the accent fill with the on-accent check when ticked, the label 10 after it at the body
     * size; the row's own 12 above and below in the 16 gutter.
     */
    private fun checkRow(): View {
        val size = dp(CHECKBOX_DP)
        val box = { on: Boolean ->
            GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(2).toFloat()
                setSize(size, size)
                if (on) setColor(accent) else { setColor(pageColor); setStroke(1, ColorUtils.setAlphaComponent(ink, (0.3f * 255).toInt())) }
            }
        }
        val mark = ContextCompat.getDrawable(activity, R.drawable.ic_check)!!.mutate().also { DrawableCompat.setTint(it, onAccent) }
        val ticked: Drawable = LayerDrawable(arrayOf(box(true), InsetDrawable(mark, dp(2)))).apply { setBounds(0, 0, size, size) }
        val button = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_checked), ticked)
            addState(intArrayOf(), box(false))
            setBounds(0, 0, size, size)
        }
        return CheckBox(activity).apply {
            text = PageDialogSpec.SUPPRESS_LABEL
            setTextColor(ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            TextViewCompat.setLineHeight(this, sp(20))
            buttonDrawable = button
            gravity = Gravity.TOP or Gravity.START
            setPadding(dp(10), dp(12), dp(16), dp(12))
            minHeight = 0
            minimumHeight = 0
            background = null
            check = this
        }.let { row ->
            // The box in the 16 gutter: the row's start padding is the gutter, the label's 10 after the box.
            FrameLayout(activity).apply {
                setPadding(dp(16), 0, 0, 0)
                addView(row, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            }
        }
    }

    /** §9.11: peers splitting the width at an 8 gap, the primary trailing; 16 above and to the sides, 8 below. */
    private fun footer(): View {
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(16), dp(16), dp(16), dp(8))
        }
        val peer = LinearLayout.LayoutParams(0, dp(CONTROL_DP), 1f)
        if (spec.cancellable) {
            row.addView(button("Cancel", primary = false) { cancel() }, LinearLayout.LayoutParams(peer))
            row.addView(button(spec.acceptLabel, primary = true) { accept() }, LinearLayout.LayoutParams(peer).apply { marginStart = dp(8) })
        } else {
            row.addView(button(spec.acceptLabel, primary = true) { accept() }, LinearLayout.LayoutParams(peer))
        }
        return row
    }

    /** `.zen-v2-button`: the control height and radius, 15/500, the fill (or the accent) with its pressed shade. */
    private fun button(label: String, primary: Boolean, onClick: () -> Unit): View {
        val shade = { color: Int ->
            GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(CONTROL_RADIUS_DP).toFloat()
                setColor(color)
            }
        }
        val pressed = if (primary) ColorUtils.blendARGB(accent, onAccent, 0.3f) else fillPressed
        return TextView(activity).apply {
            text = label
            gravity = Gravity.CENTER
            setTextColor(if (primary) onAccent else ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = weight(500)
            maxLines = 1
            minWidth = dp(96)
            setPadding(dp(16), 0, dp(16), 0)
            background = StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_pressed), shade(pressed))
                addState(intArrayOf(), shade(if (primary) accent else fill))
            }
            isClickable = true
            isFocusable = true
            ViewCompat.setAccessibilityDelegate(this, object : AccessibilityDelegateCompat() {
                override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
                    super.onInitializeAccessibilityNodeInfo(host, info)
                    info.className = Button::class.java.name
                }
            })
            setOnClickListener { onClick() }
        }
    }

    // --- the recede of the page behind ---------------------------------------------------------

    private fun setRecede(p: Float) {
        if (!motion) return
        recede = p
        page?.setRecede(p)
    }

    private fun animateRecede(to: Float) {
        if (!motion) return
        recedeAnimator?.cancel()
        if (recede == to) return
        recedeAnimator = ValueAnimator.ofFloat(recede, to).apply {
            duration = RECEDE_MS
            addUpdateListener { setRecede(it.animatedValue as Float) }
            start()
        }
    }

    // --- measure ---------------------------------------------------------------------------

    /**
     * The tallest the scrolling body may stand: the window less the status bar, the 40 dp kept
     * above a sheet so the page shows over it, the sheet's own grip and footer, and the gesture
     * bar the sheet pads for underneath.
     */
    private fun bodyMaxHeight(): Int {
        val decor = activity.window.decorView
        val insets = ViewCompat.getRootWindowInsets(decor)?.getInsets(WindowInsetsCompat.Type.systemBars())
        val window = if (decor.height > 0) decor.height else activity.resources.displayMetrics.heightPixels
        return (window - (insets?.top ?: 0) - (insets?.bottom ?: 0) - dp(40 + GRIP_DP + FOOTER_DP)).coerceAtLeast(dp(120))
    }

    /** A scroller that grows with its content up to `maxHeight`, then scrolls. */
    private inner class MaxHeightScrollView(private val maxHeight: Int) : ScrollView(activity) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val mode = MeasureSpec.getMode(heightMeasureSpec)
            val size = MeasureSpec.getSize(heightMeasureSpec)
            val capped = if (mode == MeasureSpec.UNSPECIFIED || size > maxHeight) MeasureSpec.makeMeasureSpec(maxHeight, MeasureSpec.AT_MOST) else heightMeasureSpec
            super.onMeasure(widthMeasureSpec, capped)
        }
    }

    private fun weight(weight: Int): Typeface =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(null, weight, false)
        else if (weight >= 600) Typeface.DEFAULT_BOLD else Typeface.DEFAULT

    private fun dp(value: Int): Int = (value * density + 0.5f).toInt()
    private fun sp(value: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value.toFloat(), activity.resources.displayMetrics).toInt()

    companion object {
        /** §9.9: the grip strip. */
        const val GRIP_DP = 20
        /** The phone's control height (`--v2-control`), radius (`--v2-radius-control` on a coarse pointer) and checkbox. */
        const val CONTROL_DP = 40
        const val CONTROL_RADIUS_DP = 6
        const val CHECKBOX_DP = 20
        /** The footer's control with its 16 above and 8 below. */
        const val FOOTER_DP = CONTROL_DP + 16 + 8
        /** The recede's own motion where the sheet's is the window's slide (its entry): the sheet animation's length. */
        const val RECEDE_MS = 250L
    }
}
