package app.zen.chromium

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.text.InputType
import android.text.TextUtils
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
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.core.widget.TextViewCompat
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * The numbers of the v2 prompt sheet (design language v2 §9.23 and what it names: §9.9 grabber,
 * §9.11 footer, §9.12 field, §9.14 checkbox, §6 button), each after the token or rule it is
 * taken from. `V2TokensPinTest` holds them equal to main.css, so the imitation cannot drift
 * from the sheet the chrome draws.
 */
object PromptSheetSpec {
    /** `--v2-radius-sheet`: the sheet's top corners. */
    const val SHEET_RADIUS_DP = 12
    /** `.zen-sheet`'s `border: 1px`: the hairline round the sheet, a field, a checkbox. */
    const val HAIRLINE_PX = 1
    /** `SHEET_TOP_MARGIN` (lib/motion/sheet.ts): the page kept in view above an expanded sheet. */
    const val SHEET_TOP_MARGIN_DP = 40

    /** §9.9: the grip strip, with the 32 × 4 grabber at radius 2, 8 from the top, in the text at 25 %. */
    const val GRIP_STRIP_DP = 20
    const val GRABBER_WIDTH_DP = 32
    const val GRABBER_HEIGHT_DP = 4
    const val GRABBER_RADIUS_DP = 2
    const val GRABBER_TOP_DP = 8
    const val GRABBER_ALPHA = 0.25f

    /** §9.23: the title block's padding (`.zen-sheet-title-block`), its glyph and the glyph's gap. */
    const val BLOCK_PADDING_DP = 16
    const val GLYPH_DP = 20
    const val GLYPH_GAP_DP = 8
    /** `--v2-font-heading` / `--v2-line-heading` / `--v2-weight-heading`: the title. */
    const val TITLE_SP = 17
    const val TITLE_LINE_SP = 22
    const val TITLE_WEIGHT = 600
    /** `--v2-font-body` / `--v2-line-body`: the description, a label, a field's text. */
    const val BODY_SP = 15
    const val BODY_LINE_SP = 20
    /** `--v2-text-deemphasized`: the description's ink is the text at 69 %. */
    const val DEEMPHASIZED_ALPHA = 0.69f
    /** `.zen-sheet-title-block`'s gap: the description 4 under the title. */
    const val DESCRIPTION_GAP_DP = 4

    /** `--v2-control` on a phone: a field's and a button's height. */
    const val CONTROL_DP = 40
    /** `--v2-radius-control` under a coarse pointer: a field's and a button's corners. */
    const val CONTROL_RADIUS_DP = 6
    /** `.zen-v2-field`'s `padding: 0 12px`. */
    const val FIELD_PADDING_DP = 12
    /** The 16 gutter (§5): the body's sides, a row's sides, the footer's. */
    const val GUTTER_DP = 16

    /** `--v2-checkbox` on a phone and `--v2-radius-checkbox`; the edge at rest is the text at 30 % (`.zen-v2-checkbox`). */
    const val CHECKBOX_DP = 20
    const val CHECKBOX_RADIUS_DP = 2
    const val CHECKBOX_BORDER_ALPHA = 0.3f
    /** The mark inside a ticked box: the box less 4 (`calc(var(--v2-checkbox) - 4px)`). */
    const val CHECK_MARK_INSET_DP = 2
    /** `.zen-v2-row` on a phone: 44 tall, 12 above and below the line, the box 12 before the label. */
    const val ROW_MIN_DP = 44
    const val ROW_PAD_DP = 12
    const val ROW_GAP_DP = 12

    /** `.zen-sheet-footer` (§9.11): `padding: 16px 16px 8px`, the peers at an 8 gap. */
    const val FOOTER_TOP_DP = 16
    const val FOOTER_BOTTOM_DP = 8
    const val PEER_GAP_DP = 8
    /** `.zen-v2-button`: `min-width: 96px`, `padding: 0 16px`, the label at `--v2-weight-button`. */
    const val BUTTON_MIN_WIDTH_DP = 96
    const val BUTTON_PADDING_DP = 16
    const val BUTTON_WEIGHT = 500
    /** `--v2-fill` / `--v2-fill-hover`: a secondary's fill is the text at 10 %, 16 % under a press. */
    const val FILL_ALPHA = 0.10f
    const val FILL_PRESSED_ALPHA = 0.16f
    /** `.zen-v2-button[data-primary]:active`: the accent mixed 30 % towards the on-accent ink. */
    const val ACCENT_PRESSED_MIX = 0.3f
    /** `.zen-v2-button`'s `transition: background 120ms`: a press fill's fade. */
    const val PRESS_FADE_MS = 120

    /** `--zen-scrim-alpha`: the one scrim, black at .4 light and .55 dark (`themes.xml`'s dim). */
    const val SCRIM_ALPHA_LIGHT = 0.4f
    const val SCRIM_ALPHA_DARK = 0.55f
    /** §11.3: the sheet comes and goes on a 120 ms opacity fade in place (`res/anim/prompt_sheet_*`). */
    const val FADE_MS = 120
}

/**
 * The v2 prompt sheet (§9.23) as a native Android view: one chassis for every prompt the chrome
 * cannot draw itself. The page's own dialogs – `alert` / `confirm` / `prompt`, a `beforeunload`
 * question (PUI-27 / PUI-28) – come up while the renderer every WebView of the app shares waits
 * inside the very call the prompt answers, and the unresponsive-page prompt (ERR-16) while that
 * renderer has stopped answering: nothing the chrome's JavaScript draws can come up meanwhile,
 * so the composition is imitated here, held to the sheet's numbers ([PromptSheetSpec]) and the
 * theme's inks ([V2Ink]) exactly, both pinned against main.css by `V2TokensPinTest`.
 *
 * The composition, top to bottom: the panel surface with its hairline and 12 top radii, edge to
 * edge at the bottom; the §9.9 grip strip; the title block – an optional 20 glyph on the title's
 * start at the 8 gap, the title 17/600 on 22, an optional description 15 at 69 % on 20, 4 under
 * it – then, in the 16 gutter, an optional §9.12 field prefilled with its text, and an optional
 * §9.14 check row ("Don't ask again", "Don't let this page create more dialogs") whose tick is
 * submitted with the answer; 16 to the §9.11 footer: two 40 peers splitting the width at 8, the
 * secondary (Cancel, Wait) leading in the 10 % fill, the primary trailing – the accent fill with
 * the on-accent label, or, for a destructive answer, the 10 % fill with the label in the danger
 * ink (Exit page, Remove) – or one action spanning the row. A long body scrolls between the
 * grip and the footer; the sheet stands at most [PromptSheetSpec.SHEET_TOP_MARGIN_DP] under the
 * status bar. The keyboard lifts the sheet.
 *
 * Motion is the 120 ms opacity fade of §11.3 in place, by default, scrim with sheet
 * ([Motion.FADE]): no slide, no drag, no recede of the page behind – the native allowance the
 * §9.23 line grants an imitation. [Motion.SLIDE] is the platform sheet's slide and drag, kept
 * behind the flag for the day the lead reopens it; a consumer that recedes the page reads
 * [onSlide] then.
 *
 * Answering: the primary accepts ([Answer.accepted] true, a field's text with it; the field's
 * Done key is the primary); the secondary, the scrim, the system back, the grabber and a drag
 * (under [Motion.SLIDE]) answer the secondary – `accepted` false – so a dismissal is always the
 * answer that changes nothing. One answer per sheet, ever.
 *
 * TalkBack: the window is a dialog named by the title (the platform announces it as the sheet
 * comes up); the title is a heading; the container takes the focus, as §9.22 has a
 * title-and-notice sheet and a form sheet do – never the field, whose keyboard would come up
 * with the sheet, and never Cancel, which would be the first thing read – and the field takes
 * the focus, and the keyboard with it, on the user's tap.
 */
class NativePromptSheet(
    private val context: Context,
    private val ink: V2Ink,
    private val content: Content,
    private val motion: Motion = Motion.FADE,
    /** Under [Motion.SLIDE]: the sheet's progress, 0 gone to 1 standing, frame for frame on a drag. */
    private val onSlide: ((Float) -> Unit)? = null,
    private val onAnswer: (Answer) -> Unit
) {
    /** What the sheet says and offers. */
    class Content(
        /** The title line, 17/600: "example.com says", "Leave site?", the unresponsive site's host. */
        val title: CharSequence,
        /** The description 15 at 69 %, 4 under the title: the page's message, our sentence. Line breaks kept. */
        val description: CharSequence? = null,
        /** A 20 glyph on the title's start (a favicon, a globe in the ink: [V2Ink.glyph]); none for a dialog without an identity. */
        val glyph: Drawable? = null,
        /** The title on one line, truncated from the end (a host name); false: it wraps. */
        val titleOneLine: Boolean = false,
        /** A §9.12 field under the block, prefilled; its text comes back with an accepting answer. */
        val field: Field? = null,
        /** The label of a §9.14 check row after the body; its tick comes back with every answer. */
        val check: CharSequence? = null,
        /** The leading peer's label (Cancel, Wait). None: the primary spans the row alone. */
        val secondary: CharSequence? = null,
        /** The trailing peer: its label and its tone. */
        val primary: Peer
    )

    /** A §9.12 field: its initial text (selected when the field takes the focus) and its hint. */
    class Field(val text: String = "", val hint: CharSequence? = null, val inputType: Int = InputType.TYPE_CLASS_TEXT)

    /** A footer button: its label and how it is drawn. */
    class Peer(val label: CharSequence, val tone: Tone = Tone.ACCENT)

    /** How a footer button is drawn (§6, §9.11): the accent primary, the plain secondary, the destructive secondary. */
    enum class Tone { ACCENT, PLAIN, DANGER }

    /** How the sheet comes and goes. */
    enum class Motion { FADE, SLIDE }

    /** The one answer: whether the primary was taken, the field's text if it was, the check row's tick. */
    class Answer(val accepted: Boolean, val text: String?, val checked: Boolean)

    private val density = context.resources.displayMetrics.density
    private var dialog: BottomSheetDialog? = null
    private var field: EditText? = null
    private var check: CheckBox? = null
    private var answered = false

    /** Whether the sheet is up. */
    val showing: Boolean get() = dialog != null

    fun show() {
        if (dialog != null) return
        val theme = when (motion) {
            Motion.FADE -> if (ink.dark) R.style.ThemeOverlay_Zen_PromptSheet_Dark else R.style.ThemeOverlay_Zen_PromptSheet
            Motion.SLIDE -> if (ink.dark) R.style.ThemeOverlay_Zen_Sheet_Dark else R.style.ThemeOverlay_Zen_Sheet
        }
        val dialog = BottomSheetDialog(context, theme)
        this.dialog = dialog
        val column = content()
        dialog.setContentView(column)
        // The window's name for TalkBack is the title, as a dialog's is.
        dialog.setTitle(content.title)
        dialog.setCanceledOnTouchOutside(true)
        dialog.behavior.skipCollapsed = true
        dialog.behavior.isFitToContents = true
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        dialog.behavior.isDraggable = motion == Motion.SLIDE
        dialog.dismissWithAnimation = motion == Motion.SLIDE
        if (motion == Motion.SLIDE && onSlide != null) dialog.behavior.addBottomSheetCallback(object : BottomSheetBehavior.BottomSheetCallback() {
            override fun onStateChanged(bottomSheet: View, newState: Int) {}
            override fun onSlide(bottomSheet: View, slideOffset: Float) {
                val parent = bottomSheet.parent as? View ?: return
                if (bottomSheet.height <= 0) return
                this@NativePromptSheet.onSlide.invoke(((parent.height - bottomSheet.top).toFloat() / bottomSheet.height).coerceIn(0f, 1f))
            }
        })
        // §9.22: the keyboard never comes up with the sheet; the field's tap brings it. Before
        // Android 11 the window makes room for it; from 11 on the column pads (content()).
        dialog.window?.setSoftInputMode(
            WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN or
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) legacyResize() else 0
        )
        dialog.setOnDismissListener {
            if (this.dialog !== dialog) return@setOnDismissListener
            this.dialog = null
            answer(accepted = false)
        }
        dialog.show()
        // §9.22: the container takes the focus, not the first control.
        column.requestFocus()
    }

    /** Take the sheet down without an answer of its own (what it asked about is gone). */
    fun dismiss() {
        val d = dialog ?: return
        answered = true
        dialog = null
        d.dismiss()
    }

    private fun accept() {
        answer(accepted = true)
        dialog?.cancel()
    }

    private fun decline() {
        answer(accepted = false)
        dialog?.cancel()
    }

    private fun answer(accepted: Boolean) {
        if (answered) return
        answered = true
        val text = if (accepted) field?.text?.toString() else null
        onAnswer(Answer(accepted, text, check?.isChecked == true))
    }

    // --- the composition -----------------------------------------------------------------------

    private fun content(): View {
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = edge()
            // The container holds the focus on open (§9.22); it draws no ring for it.
            isFocusable = true
            isFocusableInTouchMode = true
            defaultFocusHighlightEnabled = false
            ViewCompat.setAccessibilityPaneTitle(this, content.title)
        }
        column.addView(grip(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(PromptSheetSpec.GRIP_STRIP_DP)))
        val body = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        body.addView(titleBlock())
        content.field?.let { spec ->
            body.addView(field(spec), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(PromptSheetSpec.CONTROL_DP)).apply {
                marginStart = dp(PromptSheetSpec.GUTTER_DP)
                marginEnd = dp(PromptSheetSpec.GUTTER_DP)
            })
        }
        content.check?.let { label ->
            // The row's own 12 above its line; after a field it is the block's 16 less that 12.
            body.addView(checkRow(label), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                if (content.field != null) topMargin = dp(PromptSheetSpec.BLOCK_PADDING_DP - PromptSheetSpec.ROW_PAD_DP)
            })
        }
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

    /** The hairline round the sheet at its top radii, over the panel fill the sheet style paints. */
    private fun edge(): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        val r = dp(PromptSheetSpec.SHEET_RADIUS_DP).toFloat()
        cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
        setColor(Color.TRANSPARENT)
        setStroke(PromptSheetSpec.HAIRLINE_PX, ink.border)
    }

    /** §9.9: the grabber in its strip; a tap on the strip dismisses (the grip is the first thing in the order). */
    private fun grip(): View {
        val strip = FrameLayout(context)
        val bar = View(context).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(PromptSheetSpec.GRABBER_RADIUS_DP).toFloat()
                setColor(ink.grabber)
            }
        }
        strip.addView(bar, FrameLayout.LayoutParams(dp(PromptSheetSpec.GRABBER_WIDTH_DP), dp(PromptSheetSpec.GRABBER_HEIGHT_DP), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
            topMargin = dp(PromptSheetSpec.GRABBER_TOP_DP)
        })
        strip.contentDescription = context.getString(R.string.prompt_sheet_dismiss)
        strip.isClickable = true
        strip.isFocusable = true
        strip.setOnClickListener { decline() }
        return strip
    }

    /**
     * §9.23: the glyph and the title on one line, the description 4 under, in the block's 16.
     * The block keeps no bottom padding of its own: a field or a check row follows at the 16,
     * and the footer brings its own 16 (`.zen-sheet-footer`).
     */
    private fun titleBlock(): View {
        val pad = dp(PromptSheetSpec.BLOCK_PADDING_DP)
        val block = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, if (content.field != null || content.check != null) pad else 0)
        }
        val title = TextView(context).apply {
            text = content.title
            setTextColor(ink.text)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, PromptSheetSpec.TITLE_SP.toFloat())
            typeface = weight(PromptSheetSpec.TITLE_WEIGHT)
            TextViewCompat.setLineHeight(this, sp(PromptSheetSpec.TITLE_LINE_SP))
            if (content.titleOneLine) {
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
            }
            ViewCompat.setAccessibilityHeading(this, true)
        }
        val glyph = content.glyph
        if (glyph == null) block.addView(title) else {
            val identity = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            identity.addView(ImageView(context).apply {
                setImageDrawable(glyph)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(dp(PromptSheetSpec.GLYPH_DP), dp(PromptSheetSpec.GLYPH_DP)).apply { marginEnd = dp(PromptSheetSpec.GLYPH_GAP_DP) })
            identity.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            block.addView(identity, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        val description = content.description
        if (!description.isNullOrEmpty()) block.addView(TextView(context).apply {
            text = description
            setTextColor(ink.textDeemphasized)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, PromptSheetSpec.BODY_SP.toFloat())
            TextViewCompat.setLineHeight(this, sp(PromptSheetSpec.BODY_LINE_SP))
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(PromptSheetSpec.DESCRIPTION_GAP_DP)
        })
        return block
    }

    /** §9.12: the page surface in a hairline box at the control radius, 12 in, the accent edge while focused. */
    private fun field(spec: Field): View {
        val box = { edge: Int ->
            GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(PromptSheetSpec.CONTROL_RADIUS_DP).toFloat()
                setColor(ink.page)
                setStroke(PromptSheetSpec.HAIRLINE_PX, edge)
            }
        }
        return EditText(context).apply {
            setText(spec.text)
            hint = spec.hint
            setSelectAllOnFocus(true)
            setTextColor(ink.text)
            setHintTextColor(ink.textDeemphasized)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, PromptSheetSpec.BODY_SP.toFloat())
            inputType = spec.inputType
            imeOptions = EditorInfo.IME_ACTION_DONE
            isSingleLine = true
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(PromptSheetSpec.FIELD_PADDING_DP), 0, dp(PromptSheetSpec.FIELD_PADDING_DP), 0)
            background = StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_focused), box(ink.accent))
                addState(intArrayOf(), box(ink.border))
            }
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_DONE) { accept(); true } else false
            }
            field = this
        }
    }

    /**
     * §9.14 in a prompt (§9.23): the 20 box at radius 2 on the label's first line – the page
     * surface in the ink's 30 % hairline, the accent with the on-accent mark when ticked – the
     * label 12 after it at the body size, in a 44 row with 12 above and below, in the 16 gutter.
     */
    private fun checkRow(label: CharSequence): View {
        val size = dp(PromptSheetSpec.CHECKBOX_DP)
        val box = { on: Boolean ->
            GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(PromptSheetSpec.CHECKBOX_RADIUS_DP).toFloat()
                setSize(size, size)
                if (on) setColor(ink.accent) else {
                    setColor(ink.page)
                    setStroke(PromptSheetSpec.HAIRLINE_PX, ink.checkboxBorder)
                }
            }
        }
        // The mark (ic_check, drawn at the box less 4) 2 inside the accent box.
        val ticked: Drawable = LayerDrawable(arrayOf(box(true), InsetDrawable(ink.glyph(R.drawable.ic_check, ink.onAccent), dp(PromptSheetSpec.CHECK_MARK_INSET_DP))))
        // The box sits on the first text line: the row's 12 above it is the drawable's own inset,
        // since a compound button draws its box from its top edge, not its padding's.
        val rowPad = dp(PromptSheetSpec.ROW_PAD_DP)
        val onLine = { d: Drawable -> InsetDrawable(d, 0, rowPad, 0, 0) }
        val button = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_checked), onLine(ticked))
            addState(intArrayOf(), onLine(box(false)))
        }
        val row = CheckBox(context).apply {
            text = label
            setTextColor(ink.text)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, PromptSheetSpec.BODY_SP.toFloat())
            TextViewCompat.setLineHeight(this, sp(PromptSheetSpec.BODY_LINE_SP))
            buttonDrawable = button
            gravity = Gravity.TOP or Gravity.START
            setPadding(dp(PromptSheetSpec.ROW_GAP_DP), rowPad, dp(PromptSheetSpec.GUTTER_DP), rowPad)
            minHeight = dp(PromptSheetSpec.ROW_MIN_DP)
            minimumHeight = dp(PromptSheetSpec.ROW_MIN_DP)
            background = null
            check = this
        }
        return FrameLayout(context).apply {
            setPadding(dp(PromptSheetSpec.GUTTER_DP), 0, 0, 0)
            addView(row, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
    }

    /** §9.11: peers splitting the width at 8, the primary trailing; one action spans the row. */
    private fun footer(): View {
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(PromptSheetSpec.GUTTER_DP), dp(PromptSheetSpec.FOOTER_TOP_DP), dp(PromptSheetSpec.GUTTER_DP), dp(PromptSheetSpec.FOOTER_BOTTOM_DP))
        }
        val peer = { LinearLayout.LayoutParams(0, dp(PromptSheetSpec.CONTROL_DP), 1f) }
        content.secondary?.let { label ->
            row.addView(button(label, Tone.PLAIN) { decline() }, peer())
        }
        row.addView(button(content.primary.label, content.primary.tone) { accept() }, peer().apply {
            if (content.secondary != null) marginStart = dp(PromptSheetSpec.PEER_GAP_DP)
        })
        return row
    }

    /** `.zen-v2-button` as a view: the control's height and radius, the label 15/500, the fill with its pressed shade. */
    private fun button(label: CharSequence, tone: Tone, onClick: () -> Unit): View {
        val shade = { color: Int ->
            GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(PromptSheetSpec.CONTROL_RADIUS_DP).toFloat()
                setColor(color)
            }
        }
        val accent = tone == Tone.ACCENT
        return TextView(context).apply {
            text = label
            gravity = Gravity.CENTER
            setTextColor(when (tone) { Tone.ACCENT -> ink.onAccent; Tone.DANGER -> ink.danger; Tone.PLAIN -> ink.text })
            setTextSize(TypedValue.COMPLEX_UNIT_SP, PromptSheetSpec.BODY_SP.toFloat())
            typeface = weight(PromptSheetSpec.BUTTON_WEIGHT)
            maxLines = 1
            minWidth = dp(PromptSheetSpec.BUTTON_MIN_WIDTH_DP)
            setPadding(dp(PromptSheetSpec.BUTTON_PADDING_DP), 0, dp(PromptSheetSpec.BUTTON_PADDING_DP), 0)
            background = StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_pressed), shade(if (accent) ink.accentPressed else ink.fillPressed))
                addState(intArrayOf(), shade(if (accent) ink.accent else ink.fill))
                setExitFadeDuration(PromptSheetSpec.PRESS_FADE_MS)
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

    // --- measure ---------------------------------------------------------------------------

    /**
     * The tallest the scrolling body may stand: the window less the status bar, the margin kept
     * above an expanded sheet so the page shows over it, the grip and the footer, and the
     * gesture bar the sheet pads for underneath.
     */
    private fun bodyMaxHeight(): Int {
        val decor = (context as? android.app.Activity)?.window?.decorView
        val insets = decor?.let { ViewCompat.getRootWindowInsets(it)?.getInsets(WindowInsetsCompat.Type.systemBars()) }
        val window = if (decor != null && decor.height > 0) decor.height else context.resources.displayMetrics.heightPixels
        val footer = PromptSheetSpec.FOOTER_TOP_DP + PromptSheetSpec.CONTROL_DP + PromptSheetSpec.FOOTER_BOTTOM_DP
        return (window - (insets?.top ?: 0) - (insets?.bottom ?: 0) - dp(PromptSheetSpec.SHEET_TOP_MARGIN_DP + PromptSheetSpec.GRIP_STRIP_DP + footer))
            .coerceAtLeast(dp(3 * PromptSheetSpec.CONTROL_DP))
    }

    /** A scroller that grows with its content up to `maxHeight`, then scrolls. */
    private inner class MaxHeightScrollView(private val maxHeight: Int) : ScrollView(context) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val mode = MeasureSpec.getMode(heightMeasureSpec)
            val size = MeasureSpec.getSize(heightMeasureSpec)
            val capped = if (mode == MeasureSpec.UNSPECIFIED || size > maxHeight) MeasureSpec.makeMeasureSpec(maxHeight, MeasureSpec.AT_MOST) else heightMeasureSpec
            super.onMeasure(widthMeasureSpec, capped)
        }
    }

    /** Before Android 11 the window itself is resized for the keyboard (deprecated there, where the column pads instead). */
    @Suppress("DEPRECATION")
    private fun legacyResize(): Int = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE

    /** The scale's weights (600 titles, 500 buttons) on the system font; before API 28 the nearest named face. */
    private fun weight(w: Int): Typeface =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, w, false)
        else if (w >= 600) Typeface.DEFAULT_BOLD else Typeface.create("sans-serif-medium", Typeface.NORMAL)

    private fun dp(value: Int): Int = (value * density + 0.5f).toInt()
    private fun sp(value: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value.toFloat(), context.resources.displayMetrics).toInt()
}
