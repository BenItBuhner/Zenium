package app.zen.chromium

import android.content.Context
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
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
import android.view.ContextThemeWrapper
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
import androidx.core.graphics.drawable.DrawableCompat
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.core.widget.TextViewCompat
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * The numbers of the v2 prompt sheet (design language v2 §9.23 and what it names: §9.7 hairline,
 * §9.9 grabber, §9.11 footer, §9.12 field, §9.14 checkbox, §9.25 gutter and inset, §6 button),
 * each after the token or rule it is taken from. `V2TokensPinTest` holds them equal to main.css,
 * so the imitation cannot drift from the sheet the chrome draws.
 */
object PromptSheetSpec {
    /** `--v2-radius-sheet`: the sheet's top corners. */
    const val SHEET_RADIUS_DP = 12
    /**
     * `.zen-sheet`'s `border: 1px` – a CSS px, one dp on the device: the hairline round the sheet's
     * top and sides (`border-bottom: 0`: none along the screen's edge), under a scrolled title block
     * (§9.7), round a field (§9.12), a checkbox (§9.14). Drawn at [hairlinePx].
     */
    const val HAIRLINE_DP = 1
    /** `SHEET_TOP_MARGIN` (lib/motion/sheet.ts): the page kept in view above an expanded sheet. */
    const val SHEET_TOP_MARGIN_DP = 40

    /**
     * The hairline in device pixels: [HAIRLINE_DP] at the density, rounded, never under one pixel – 1
     * at 1x, 2 at 1.75x, 3 at 2.625x – as the chrome's 1 CSS px border is one dp of the screen and
     * a physical pixel would be 0.57 dp at 1.75x.
     */
    fun hairlinePx(density: Float): Int = maxOf(1, Math.round(HAIRLINE_DP * density))

    /**
     * §9.25's formula: the footer's buttons stand 16 above the host's safe-area inset, so the gap
     * from the peers to the sheet's bottom edge is the gutter plus the inset the host reports – its
     * three hosts: 16 where it reports none (the preview host), 40 over a 24 gesture bar, 64 over a
     * 48 three-button bar, the sheet running edge to edge beneath the bar. Natively the Material
     * sheet pads its bottom by the inset and the footer brings the 16 ([FOOTER_BOTTOM_DP]); the
     * web chassis makes the same 16 of `.zen-sheet-footer`'s 8 over `BottomSheet.tsx`'s own 8
     * (`SHEET_EDGE_PAD`) and adds the inset to it. `V2TokensPinTest` holds both to the formula on
     * the three hosts.
     */
    fun footerToEdge(gutter: Int, inset: Int): Int = gutter + inset

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
    /** `--v2-font-body` / `--v2-line-body` / `--v2-weight-body`: body copy, the description, a label, a field's text. */
    const val BODY_SP = 15
    const val BODY_LINE_SP = 20
    const val BODY_WEIGHT = 400
    /** `--v2-text-deemphasized`: the description's ink is the text at 69 %. */
    const val DEEMPHASIZED_ALPHA = 0.69f
    /** `.zen-sheet-title-block`'s gap: the description 4 under the title. */
    const val DESCRIPTION_GAP_DP = 4
    /** §9.23: body copy 16 from what it introduces – the title block's 16 to the body (§9.7), a paragraph's 16 to the row or field after it. */
    const val BODY_GAP_DP = 16
    /** §9.7: the hairline under a pinned title block comes and goes on `.zen-sheet-grip`'s 120 ms. */
    const val HAIRLINE_FADE_MS = 120

    /** `--v2-control` on a phone: a field's and a button's height. */
    const val CONTROL_DP = 40
    /** `--v2-radius-control` under a coarse pointer: a field's and a button's corners. */
    const val CONTROL_RADIUS_DP = 6
    /** `.zen-v2-field`'s `padding: 0 12px`. */
    const val FIELD_PADDING_DP = 12
    /** §9.12: the label 4 above its field (`.zen-bm-label`'s gap). */
    const val LABEL_GAP_DP = 4
    /** The 16 gutter (§9.25): the body's sides, a row's sides, the footer's. */
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

    /**
     * §9.11 / §9.25: the footer's 16 above its peers (`.zen-sheet-footer`'s `padding-top`), the peers at an
     * 8 gap, and §9.25's 16 below them, above the host's safe-area inset the sheet pads for
     * ([footerToEdge]: 16 + the inset to the sheet's edge) – the web chassis's `.zen-sheet-footer`
     * 8 over `BottomSheet.tsx`'s `SHEET_EDGE_PAD` 8, the inset added to both, pinned equal.
     */
    const val FOOTER_TOP_DP = 16
    const val FOOTER_BOTTOM_DP = 16
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
    /** `--v2-selection` (§9.6): selected text sits on the accent at 30 %. */
    const val SELECTION_ALPHA = 0.3f
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
 * The composition, top to bottom: the panel surface with its 12 top radii and the hairline round
 * its top and sides (none along the screen's edge, as `.zen-sheet`'s `border-bottom: 0`; every
 * hairline one dp – [PromptSheetSpec.hairlinePx] – as the chrome's 1 CSS px), edge to edge at
 * the bottom; the §9.9 grip strip; the title block, PINNED – an optional 20 glyph on the
 * title's start at the 8 gap, the title 17/600 on 22, and an optional description 15 at 69 % on
 * 20, 4 under it, for a sentence of OURS ("Changes you made may not be saved.", "This page isn't
 * responding…") – 16 to the body; the body, which SCROLLS under the block with §9.7's hairline at
 * the boundary once it has moved: optional body copy 15/400 in the text ink – the PAGE's words,
 * an `alert`'s or `confirm`'s message, which may run long –, an optional §9.12 field under its
 * label (a `prompt`'s message is that label, 4 above the 40 field, the value selected), an
 * optional §9.14 check row ("Don't ask again", "Don't let this page create more dialogs") whose
 * tick is submitted with the answer, each 16 from the last; then the §9.11 footer, PINNED, 16
 * above its two 40 peers splitting the width at 8 – the secondary (Cancel, Wait) leading in the
 * 10 % fill, the primary trailing in the accent fill with the on-accent label or, for a
 * destructive answer, in the 10 % fill with the label in the danger ink (Exit page, Remove) –
 * or one action spanning the row; and §9.25's 16 under the peers, above the host's safe-area
 * inset the sheet pads for – 16 to the edge where it reports none, 40 over a 24 gesture bar, 64
 * over a 48 three-button bar ([PromptSheetSpec.footerToEdge]: the gutter plus the inset, §9.25's
 * formula, the web chassis's `8 + 8 + inset` the same numbers). The sheet
 * stands at most [PromptSheetSpec.SHEET_TOP_MARGIN_DP]
 * under the status bar: a long body scrolls between the pinned block and the pinned footer
 * rather than pushing either off. The keyboard lifts the sheet and takes its room from the body.
 *
 * Motion is the 120 ms opacity fade of §11.3 in place, scrim with sheet: no slide, no drag, no
 * recede of the page behind – the one motion §9.23's line allows the native chassis, and the
 * one it can do: no argument of a consumer's reaches the platform sheet's slide or drag, since
 * the sentence closes the door behind its two consumers and reopening it is a chassis change.
 *
 * Answering: the primary accepts ([Answer.accepted] true, a field's text with it; the field's
 * Done key is the primary); the secondary, the scrim, the system back and the grabber answer
 * the secondary – `accepted` false – so a dismissal is always the answer that changes nothing.
 * One answer per sheet, ever.
 *
 * TalkBack: the window is a dialog named by the title (the platform announces it as the sheet
 * comes up); the title is a heading; the container takes the focus, as §9.22 has a
 * title-and-notice sheet and a form sheet do – never the field, whose keyboard would come up
 * with the sheet, and never Cancel, which would be the first thing read – and the field takes
 * the focus, and the keyboard with it, on the user's tap; its label is read with it.
 */
class NativePromptSheet(
    private val context: Context,
    private val ink: V2Ink,
    private val content: Content,
    private val onAnswer: (Answer) -> Unit
) {
    /** What the sheet says and offers. */
    class Content(
        /** The title line, 17/600: "example.com says", "Leave site?", the unresponsive site's host. */
        val title: CharSequence,
        /** OUR sentence under the title, 15 at 69 %, 4 below it, in the pinned block: "Changes you made may not be saved." Line breaks kept. */
        val description: CharSequence? = null,
        /** The PAGE's words as body copy, 15/400 in the text ink, in the scrolling body: an alert's or confirm's message. Line breaks kept. */
        val body: CharSequence? = null,
        /** A 20 glyph on the title's start (a favicon, a globe in the ink: [V2Ink.glyph]); none for a dialog without an identity. */
        val glyph: Drawable? = null,
        /** The title on one line, truncated from the end (a host name); false: it wraps. */
        val titleOneLine: Boolean = false,
        /** A §9.12 field in the body, under its label, prefilled; its text comes back with an accepting answer. */
        val field: Field? = null,
        /** The label of a §9.14 check row after the body; its tick comes back with every answer. */
        val check: CharSequence? = null,
        /** The leading peer's label (Cancel, Wait). None: the primary spans the row alone. */
        val secondary: CharSequence? = null,
        /** The trailing peer: its label and its tone. */
        val primary: Peer
    )

    /**
     * A §9.12 field: its label 4 above it (a `prompt`'s message), its initial text – selected, so the
     * first keystroke replaces it, as Chrome's is – and its hint.
     */
    class Field(
        val text: String = "",
        val label: CharSequence? = null,
        val hint: CharSequence? = null,
        val inputType: Int = InputType.TYPE_CLASS_TEXT
    )

    /** A footer button: its label and how it is drawn. */
    class Peer(val label: CharSequence, val tone: Tone = Tone.ACCENT)

    /** How a footer button is drawn (§6, §9.11): the accent primary, the plain secondary, the destructive secondary. */
    enum class Tone { ACCENT, PLAIN, DANGER }

    /** The one answer: whether the primary was taken, the field's text if it was, the check row's tick. */
    class Answer(val accepted: Boolean, val text: String?, val checked: Boolean)

    private val density = context.resources.displayMetrics.density
    /** Every hairline's width on this screen: one dp in whole pixels. */
    private val hairline = PromptSheetSpec.hairlinePx(density)
    private var dialog: BottomSheetDialog? = null
    private var field: EditText? = null
    private var check: CheckBox? = null
    private var answered = false

    /** Whether the sheet is up. */
    val showing: Boolean get() = dialog != null

    fun show() {
        if (dialog != null) return
        // The sheet's theme: the panel, the radii, the dim – and the 120 ms fade in place of the platform's slide.
        val theme = if (ink.dark) R.style.ThemeOverlay_Zen_PromptSheet_Dark else R.style.ThemeOverlay_Zen_PromptSheet
        val dialog = BottomSheetDialog(context, theme)
        this.dialog = dialog
        val column = content()
        dialog.setContentView(column, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        // The window's name for TalkBack is the title, as a dialog's is.
        dialog.setTitle(content.title)
        dialog.setCanceledOnTouchOutside(true)
        dialog.behavior.skipCollapsed = true
        dialog.behavior.isFitToContents = true
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        // No drag, and the window's fade rather than the sheet's slide on the way out (§9.23's allowance).
        dialog.behavior.isDraggable = false
        dialog.dismissWithAnimation = false
        // §9.22: the keyboard never comes up with the sheet; the field's tap brings it. When it
        // does, the Material sheet lifts itself: it pads its bottom by the window's system-window
        // inset, which counts the keyboard under `adjustResize` (the mode the Material sheet theme
        // sets; deprecated from Android 11 for resizing the window, still what puts the keyboard
        // into that inset) – one lift, Material's own, on every level, and the column's cap
        // (Column) gives the body the room the lift takes.
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN or adjustResize())
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

    /**
     * The sheet's content: grip, the pinned title block, the scrolling body (taking what height is
     * left under the cap, so the footer stays put), the pinned footer.
     */
    private fun content(): View {
        val column = Column().apply {
            orientation = LinearLayout.VERTICAL
            background = SheetEdge()
            // The container holds the focus on open (§9.22); it draws no ring for it.
            isFocusable = true
            isFocusableInTouchMode = true
            defaultFocusHighlightEnabled = false
            ViewCompat.setAccessibilityPaneTitle(this, content.title)
        }
        column.addView(grip(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(PromptSheetSpec.GRIP_STRIP_DP)))
        val body = body()
        column.addView(titleBlock(toBody = body.childCount > 0))
        column.addView(scrollingBody(body), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        column.addView(footer())
        // The status bar, where the column's cap starts; the bottom is the Material sheet's, which
        // pads for the host's bar (or the keyboard over it) – §9.25's inset under the footer's 16.
        val insets = (context as? android.app.Activity)?.window?.decorView?.let { ViewCompat.getRootWindowInsets(it) }
        if (insets != null) column.applyInsets(insets)
        ViewCompat.setOnApplyWindowInsetsListener(column) { v, dispatched ->
            (v as Column).applyInsets(dispatched)
            dispatched
        }
        return column
    }

    /**
     * The hairline round the sheet, over the panel fill the sheet style paints: one open path up
     * the left side, round the two top radii, down the right side – the top and the sides, as
     * `.zen-sheet`'s `border: 1px` with `border-bottom: 0` – and no run along the bottom, where a
     * bottom sheet meets the screen's edge. The stroke lies inside the bounds, its outer edge on
     * the sheet's radius, one dp wide.
     */
    private inner class SheetEdge : Drawable() {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = hairline.toFloat()
            color = ink.border
        }
        private val path = Path()

        override fun onBoundsChange(bounds: Rect) {
            val half = hairline / 2f
            // The stroke's centre line: half a stroke in from the edge, its radius the sheet's less that half.
            val r = (dp(PromptSheetSpec.SHEET_RADIUS_DP) - half).coerceAtLeast(0f)
            val left = bounds.left + half
            val right = bounds.right - half
            val top = bounds.top + half
            val bottom = bounds.bottom.toFloat()
            path.reset()
            path.moveTo(left, bottom)
            path.lineTo(left, top + r)
            path.arcTo(left, top, left + 2 * r, top + 2 * r, 180f, 90f, false)
            path.lineTo(right - r, top)
            path.arcTo(right - 2 * r, top, right, top + 2 * r, 270f, 90f, false)
            path.lineTo(right, bottom)
        }

        override fun draw(canvas: Canvas) = canvas.drawPath(path, paint)
        override fun setAlpha(alpha: Int) { paint.alpha = alpha }
        override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter }
        @Deprecated("Deprecated in Java") override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
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
        announceAsButton(strip)
        strip.setOnClickListener { decline() }
        return strip
    }

    /**
     * §9.23: the glyph and the title on one line, our description 4 under, in the block's 16;
     * pinned above the body. Its 16 below is the 16 to the body (§9.7); with nothing in the body
     * the block keeps no bottom padding, since the footer brings its own 16 (`.zen-sheet-footer`).
     */
    private fun titleBlock(toBody: Boolean): View {
        val pad = dp(PromptSheetSpec.BLOCK_PADDING_DP)
        val block = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, if (toBody) pad else 0)
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
        if (!description.isNullOrEmpty()) block.addView(paragraph(description, ink.textDeemphasized), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(PromptSheetSpec.DESCRIPTION_GAP_DP)
        })
        return block
    }

    /**
     * The body, in the 16 gutter: body copy, then the field under its label, then the check row,
     * each 16 from what precedes it (the block's 16 reaching the first). Empty for a prompt that
     * is a title block and its footer alone.
     */
    private fun body(): LinearLayout {
        val body = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        val gutter = dp(PromptSheetSpec.GUTTER_DP)
        val gap = { body.childCount > 0 }
        content.body?.takeIf { it.isNotEmpty() }?.let { copy ->
            body.addView(paragraph(copy, ink.text), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                marginStart = gutter
                marginEnd = gutter
            })
        }
        content.field?.let { spec ->
            body.addView(labelledField(spec), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                marginStart = gutter
                marginEnd = gutter
                if (gap()) topMargin = dp(PromptSheetSpec.BODY_GAP_DP)
            })
        }
        content.check?.let { label ->
            // The row's own 12 above its line is part of the 16 to it.
            body.addView(checkRow(label), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                if (gap()) topMargin = dp(PromptSheetSpec.BODY_GAP_DP - PromptSheetSpec.ROW_PAD_DP)
            })
        }
        return body
    }

    /**
     * The body in its scroller under §9.7's hairline: a 1 px line in the border ink over the body's
     * top edge – the pinned block's bottom edge – that fades in once the body has scrolled under the
     * block and out again at the top, on the chassis's 120 ms; nothing at rest.
     */
    private fun scrollingBody(body: View): View {
        val frame = FrameLayout(context)
        val boundary = View(context).apply {
            setBackgroundColor(ink.border)
            alpha = 0f
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        var scrolled = false
        val scroller = BodyScroller { y ->
            val now = y > 0
            if (now == scrolled) return@BodyScroller
            scrolled = now
            boundary.animate().alpha(if (now) 1f else 0f).setDuration(PromptSheetSpec.HAIRLINE_FADE_MS.toLong()).start()
        }.apply {
            // `.zen-sheet-scroll`: no scrollbar, and no glow at the ends (`overscroll-behavior: contain`;
            // the platform's would be the Activity theme's edge colour, an ink outside the table).
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            addView(body, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        frame.addView(scroller, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        frame.addView(boundary, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, hairline, Gravity.TOP))
        return frame
    }

    /** A paragraph at the body size on its line box, 15/400, in the ink given: body copy in the text, a description at 69 %. */
    private fun paragraph(text: CharSequence, color: Int): TextView = TextView(context).apply {
        this.text = text
        setTextColor(color)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, PromptSheetSpec.BODY_SP.toFloat())
        typeface = weight(PromptSheetSpec.BODY_WEIGHT)
        TextViewCompat.setLineHeight(this, sp(PromptSheetSpec.BODY_LINE_SP))
    }

    /** §9.12: the label 15/400 in the text ink, 4 above its 40 field, read with it (`labelFor`); the field alone without one. */
    private fun labelledField(spec: Field): View {
        val group = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        val input = field(spec)
        val label = spec.label?.takeIf { it.isNotEmpty() }
        if (label != null) {
            input.id = View.generateViewId()
            group.addView(paragraph(label, ink.text).apply { labelFor = input.id }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        group.addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(PromptSheetSpec.CONTROL_DP)).apply {
            if (label != null) topMargin = dp(PromptSheetSpec.LABEL_GAP_DP)
        })
        return group
    }

    /**
     * §9.12: the page surface in a hairline box at the control radius, 12 in, the accent edge while
     * focused; the value selected, so it is replaced by the first keystroke when the field takes the
     * focus on the tap (the selection stands from the start; it shows once the field has the focus).
     * The selection sits on the accent at 30 % (§9.6, `--v2-selection`), and the cursor and the
     * selection's handles are the accent: the platform draws those three in the theme's activated
     * colour, so the field is built under `ThemeOverlay.Zen.PromptField`, which makes that colour
     * the v2 accent of the theme in force (`v2_accent_*`), and from Android 10 they are tinted with
     * the live accent besides – no ink on the sheet outside [V2Ink]'s table.
     */
    private fun field(spec: Field): EditText {
        val box = { edge: Int ->
            GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(PromptSheetSpec.CONTROL_RADIUS_DP).toFloat()
                setColor(ink.page)
                setStroke(hairline, edge)
            }
        }
        val fieldTheme = if (ink.dark) R.style.ThemeOverlay_Zen_PromptField_Dark else R.style.ThemeOverlay_Zen_PromptField
        return EditText(ContextThemeWrapper(context, fieldTheme)).apply {
            setText(spec.text)
            hint = spec.hint
            setSelectAllOnFocus(true)
            setTextColor(ink.text)
            setHintTextColor(ink.textDeemphasized)
            highlightColor = ink.selection
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                textCursorDrawable?.let { setTextCursorDrawable(accentTinted(it)) }
                textSelectHandle?.let { setTextSelectHandle(accentTinted(it)) }
                textSelectHandleLeft?.let { setTextSelectHandleLeft(accentTinted(it)) }
                textSelectHandleRight?.let { setTextSelectHandleRight(accentTinted(it)) }
            }
            setTextSize(TypedValue.COMPLEX_UNIT_SP, PromptSheetSpec.BODY_SP.toFloat())
            typeface = weight(PromptSheetSpec.BODY_WEIGHT)
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
            // Last: the single-line and input-type setters re-set the text, and the selection with it.
            setSelection(0, text.length)
            field = this
        }
    }

    /** A platform drawable of the field's (its cursor, a selection handle) in the accent. */
    private fun accentTinted(drawable: Drawable): Drawable = drawable.mutate().also { DrawableCompat.setTint(it, ink.accent) }

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
                    setStroke(hairline, ink.checkboxBorder)
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
            typeface = weight(PromptSheetSpec.BODY_WEIGHT)
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

    /**
     * §9.11: peers splitting the width at 8, the primary trailing; one action spans the row. 16
     * above the peers, and §9.25's 16 below them – above the host's inset the sheet pads for, so
     * 16 to the edge where it reports none and 40 over a 24 bar ([PromptSheetSpec.footerToEdge]).
     */
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
            announceAsButton(this)
            setOnClickListener { onClick() }
        }
    }

    /** TalkBack reads the view as a button – "OK, button", "Dismiss, button" – as the chrome's `<button>`s are read. */
    private fun announceAsButton(view: View) = ViewCompat.setAccessibilityDelegate(view, object : AccessibilityDelegateCompat() {
        override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
            super.onInitializeAccessibilityNodeInfo(host, info)
            info.className = Button::class.java.name
        }
    })

    // --- measure ---------------------------------------------------------------------------

    /**
     * The sheet's column: as tall as its content up to the cap – the height the sheet is offered
     * (the window less the bottom the Material sheet pads for: the host's bar, the keyboard while it
     * is up) less the status bar and the margin kept above an expanded sheet so the page shows over
     * it – with the body taking whatever the grip, the pinned block and the pinned footer leave
     * under it. It pads nothing at the bottom: §9.25's arithmetic ([PromptSheetSpec.footerToEdge])
     * is the sheet's padding for the bar (or the keyboard over it) under the footer's 16.
     */
    private inner class Column : LinearLayout(context) {
        private var insetTop = 0

        fun applyInsets(insets: WindowInsetsCompat) {
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            if (insetTop != bars.top) {
                insetTop = bars.top
                requestLayout()
            }
        }

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val mode = MeasureSpec.getMode(heightMeasureSpec)
            if (mode == MeasureSpec.EXACTLY) return super.onMeasure(widthMeasureSpec, heightMeasureSpec)
            val offered = if (mode == MeasureSpec.UNSPECIFIED) context.resources.displayMetrics.heightPixels else MeasureSpec.getSize(heightMeasureSpec)
            val cap = (offered - insetTop - dp(PromptSheetSpec.SHEET_TOP_MARGIN_DP)).coerceAtLeast(dp(3 * PromptSheetSpec.CONTROL_DP))
            super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(minOf(offered, cap), MeasureSpec.AT_MOST))
        }
    }

    /** The body's scroller: as tall as its content, or as tall as the column leaves it, and it says when it has scrolled. */
    private inner class BodyScroller(private val onScrolled: (Int) -> Unit) : ScrollView(context) {
        override fun onScrollChanged(l: Int, t: Int, oldl: Int, oldt: Int) {
            super.onScrollChanged(l, t, oldl, oldt)
            onScrolled(t)
        }
    }

    /**
     * `adjustResize`: deprecated from Android 11, where the window no longer resizes for the
     * keyboard, but still the mode that counts the keyboard into the window's system-window inset,
     * which the Material sheet pads its bottom by – its lift, and this chassis's.
     */
    @Suppress("DEPRECATION")
    private fun adjustResize(): Int = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE

    /** The scale's weights (600 titles, 500 buttons, 400 text) on the system font; before API 28 the nearest named face. */
    private fun weight(w: Int): Typeface =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, w, false)
        else if (w >= 600) Typeface.DEFAULT_BOLD
        else if (w >= 500) Typeface.create("sans-serif-medium", Typeface.NORMAL)
        else Typeface.DEFAULT

    private fun dp(value: Int): Int = (value * density + 0.5f).toInt()
    private fun sp(value: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value.toFloat(), context.resources.displayMetrics).toInt()
}
