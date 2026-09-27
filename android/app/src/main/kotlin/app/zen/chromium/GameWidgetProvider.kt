package app.zen.chromium

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews

/**
 * The Home-screen game widget (WID-04 / ERR-03): a one-cell face that opens Roll, Zenium's
 * offline game, in a tab of its own on `zen://game` – Chrome's Dino has no widget of its own (its
 * door on the Home screen is the quick action search widget's fourth button), so this face is
 * Zenium's, ruled at gate #607 (f): the runner – the app's mark, a ring with its dot – rolling on
 * a ground line, the ring in the brand indigo and the ground in the ink, on the quick actions
 * widget's colour roles (WID-02: the card its surface, the press its button, the system's
 * Material You roles on Android 12+, the v2 tokens below), `res/xml/appwidget_game.xml`,
 * `res/layout/widget_game.xml`, `res/drawable/ic_widget_roll.xml`. The quick actions widget's own
 * fourth button, wearing this glyph in Chrome's Dino slot, is the follow-up row the gate named.
 *
 * One tap, one landing ([Landing.GAME]): the face's `PendingIntent` is [SearchWidgetProvider]'s
 * intent shape – `MainActivity` by component, `ACTION_MAIN`, a task of its own, the landing as the
 * one extra – under a request code of its own ([FACE]), distinct from the other two widgets' (1–3,
 * 21–24) since the intents differ by their extra alone and `Intent.filterEquals` ignores extras.
 * The landing opens a new tab on `zen://game`, active, as a tab another app sent (`landing.ts`):
 * cold, it rides the core's boot answer, so the game is the window's first frame and the restored
 * tab is never seen first (the WID-07 rule); warm, `onNewIntent` hands it to the host global.
 *
 * The face is stateless – no update period, nothing to refresh – so `onUpdate` only rebuilds the
 * views (the launcher asks on placement, on the theme changing, after an update).
 */
class GameWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        val views = views(context)
        for (id in appWidgetIds) appWidgetManager.updateAppWidget(id, views)
    }

    companion object {
        /** The face – the whole card is the button – and its landing, under the game widget's request code. */
        val FACE = SearchWidgetProvider.Face(R.id.widget_game_face, Landing.GAME, REQUEST_CODE)

        /** The face's request code: the search widget's are 1–3, the quick actions widget's 21–24. */
        const val REQUEST_CODE = 31

        /** The face as the launcher shows it, wired to its landing. */
        fun views(context: Context): RemoteViews =
            RemoteViews(context.packageName, R.layout.widget_game).apply {
                setOnClickPendingIntent(FACE.viewId, SearchWidgetProvider.pendingIntent(context, FACE))
            }
    }
}
