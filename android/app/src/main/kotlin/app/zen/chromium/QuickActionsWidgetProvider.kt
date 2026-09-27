package app.zen.chromium

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import kotlin.math.ceil
import kotlin.math.max

/**
 * The Home-screen quick actions widget (WID-02): the omnibox pill with a row of buttons beside or
 * under it, in one widget the user resizes freely, as Chrome's quick action search widget
 * (`QuickActionSearchWidgetProvider.java`, `QuickActionSearchWidgetProviderDelegate.java`). The
 * bar opens the app in the omnibox; the buttons are Voice (the voice sheet), the private mask (a
 * new private tab) and the scanner (the QR scanner – Chrome's third button is Lens, which has no
 * free counterpart, so the row's stated limit puts the scanner in its slot). Chrome's fourth
 * button, the Dino game (`chrome://dino`), waits for the offline game (ERR-03): the layouts carry
 * three buttons, and [Variant.referenceWidthDp] is Chrome's less the absent slot, so the bar's
 * minimum and the width at which each remaining button gives way are Chrome's.
 *
 * Three forms, one per height the launcher gives (Chrome's `WidgetVariant`s, `Delegate.java:216-249`,
 * chosen at `:464-471`): under 72 dp the extra-small row (a 48 dp face), under 155 dp the small
 * row (72 dp), from 155 dp the medium column (155 dp; the bar over the buttons). Within a form the
 * width decides how many buttons show (`:101-110`): every button short of the reference width
 * drops one, the scanner first, then the mask, the mic last (Chrome drops Dino, Lens, Incognito,
 * Voice, `:145-174`). On Android 12+ the launcher names the sizes the widget may take
 * (`OPTION_APPWIDGET_SIZES`) and gets one face per size in a size map (Chrome's
 * `getSizeMappedRemoteViews`, `Provider.java:299-324`); below, a landscape / portrait pair from the
 * min / max cells (`:270-287`). A resize reaches [onAppWidgetOptionsChanged], which rebuilds
 * (`:149-154`). The face is stateless otherwise – no update period.
 *
 * Every tappable part's `PendingIntent` is [SearchWidgetProvider]'s intent shape with a landing of
 * its own ([Landing]), aimed at `MainActivity`; the request codes are distinct from that widget's
 * as well as from each other, since the intents differ by their extra alone and
 * `Intent.filterEquals` ignores extras – two providers sharing a code would share one token.
 */
class QuickActionsWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        for (id in appWidgetIds) appWidgetManager.updateAppWidget(id, views(context, appWidgetManager.getAppWidgetOptions(id)))
    }

    override fun onAppWidgetOptionsChanged(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) {
        appWidgetManager.updateAppWidget(appWidgetId, views(context, newOptions))
    }

    /**
     * One of the three forms, with Chrome's numbers (`values/dimens.xml:16-54` there): the layout,
     * the row's id (what a driver reads the form by), the form's height – also the floor of the
     * heights that pick it – a button's width with both its margins (what one dropped button gives
     * back), and Chrome's reference width, at which its four buttons all show.
     */
    enum class Variant(val layout: Int, val rowId: Int, val heightDp: Int, val buttonWidthDp: Int, val chromeReferenceWidthDp: Int) {
        XSMALL(R.layout.widget_quick_actions_xsmall, R.id.widget_quick_actions_row_xsmall, 48, 28 + 2 * 5, 312),
        SMALL(R.layout.widget_quick_actions_small, R.id.widget_quick_actions_row_small, 72, 48 + 2 * 0, 312),
        MEDIUM(R.layout.widget_quick_actions_medium, R.id.widget_quick_actions_row_medium, 155, 54 + 2 * 3, 264);

        /** The width at which this form's three buttons all show: Chrome's reference less the Dino slot it does not have yet. */
        val referenceWidthDp: Int get() = chromeReferenceWidthDp - buttonWidthDp * (CHROME_BUTTONS - BUTTONS.size)

        /** How many buttons a row `widthDp` wide must give up to keep the bar at its minimum (Chrome's `computeNumberOfButtonsToHide`). */
        fun buttonsToHide(widthDp: Int): Int = max(0.0, ceil((referenceWidthDp - widthDp).toDouble() / buttonWidthDp)).toInt()

        /** The buttons a row `widthDp` wide shows, in the row's order. */
        fun shown(widthDp: Int): List<SearchWidgetProvider.Face> {
            val dropped = DROP_ORDER.take(buttonsToHide(widthDp).coerceAtMost(DROP_ORDER.size))
            return BUTTONS.filter { it !in dropped }
        }

        companion object {
            /** The form for a face `heightDp` tall (Chrome's `getSearchWidgetVariantForHeight`). */
            fun forHeight(heightDp: Int): Variant = when {
                heightDp < SMALL.heightDp -> XSMALL
                heightDp < MEDIUM.heightDp -> SMALL
                else -> MEDIUM
            }
        }
    }

    companion object {
        /** The bar: the omnibox, as the search widget's face. */
        val BAR = SearchWidgetProvider.Face(R.id.widget_quick_actions_bar, Landing.SEARCH, 21)
        /** The mic: voice search. */
        val VOICE = SearchWidgetProvider.Face(R.id.widget_quick_actions_voice, Landing.VOICE, 22)
        /** The mask: a new private tab (Chrome's Incognito button). */
        val PRIVATE = SearchWidgetProvider.Face(R.id.widget_quick_actions_private, Landing.PRIVATE, 23)
        /** The scanner: the QR scanner, in Chrome's Lens slot. */
        val SCAN = SearchWidgetProvider.Face(R.id.widget_quick_actions_scan, Landing.SCAN, 24)

        /** Every tappable part, in the layouts' order. */
        val FACES: List<SearchWidgetProvider.Face> = listOf(BAR, VOICE, PRIVATE, SCAN)

        /** The row's buttons in its order – Chrome's Voice, Incognito, Lens (then Dino, which is not here yet). */
        val BUTTONS: List<SearchWidgetProvider.Face> = listOf(VOICE, PRIVATE, SCAN)

        /** The order a short row gives its buttons up in: Chrome's Dino, Lens, Incognito, Voice, less the Dino. */
        val DROP_ORDER: List<SearchWidgetProvider.Face> = listOf(SCAN, PRIVATE, VOICE)

        /** Chrome's row has four buttons; the reference widths are stated for that row. */
        const val CHROME_BUTTONS = 4

        /**
         * The faces for one widget as its launcher describes it in `options`: one per size the
         * launcher names on Android 12+, else the pre-12 landscape / portrait pair.
         */
        fun views(context: Context, options: Bundle): RemoteViews = sizeMapped(context, options) ?: orientationPair(context, options)

        /** One form at one size: the layout the height picks, the buttons the width allows, every part wired to its landing. */
        fun face(context: Context, widthDp: Int, heightDp: Int): RemoteViews {
            val variant = Variant.forHeight(heightDp)
            val shown = variant.shown(widthDp)
            return RemoteViews(context.packageName, variant.layout).apply {
                for (face in FACES) setOnClickPendingIntent(face.viewId, SearchWidgetProvider.pendingIntent(context, face))
                for (button in BUTTONS) setViewVisibility(button.viewId, if (button in shown) View.VISIBLE else View.GONE)
            }
        }

        private fun sizeMapped(context: Context, options: Bundle): RemoteViews? {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
            val sizes = sizesOf(options)
            if (sizes.isNullOrEmpty()) return null
            return RemoteViews(sizes.associateWith { face(context, it.width.toInt(), it.height.toInt()) })
        }

        private fun sizesOf(options: Bundle): List<SizeF>? =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                options.getParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES, SizeF::class.java)
            } else {
                @Suppress("DEPRECATION")
                options.getParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES)
            }

        /** Chrome's pre-12 pair (`Provider.java:80-96, 270-287`): portrait is the narrow, tall cell area, landscape the wide, short one. */
        private fun orientationPair(context: Context, options: Bundle): RemoteViews {
            val portrait = face(context, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH), options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT))
            val landscape = face(context, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH), options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT))
            return RemoteViews(landscape, portrait)
        }
    }
}
