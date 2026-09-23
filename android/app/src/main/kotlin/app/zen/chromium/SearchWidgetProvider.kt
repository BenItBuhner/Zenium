package app.zen.chromium

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/**
 * The Home-screen search widget (WID-01 / OMN-33): the omnibox pill's face at four cells by one
 * (`res/xml/appwidget_search.xml`, `res/layout/widget_search.xml`) – Zenium's mark, the omnibox's
 * hint, the mic, the private mask. Three taps, three landings ([Landing]): the face opens the app
 * with the omnibox focused and the keyboard up, the mic in voice search, the mask in a new private
 * tab. Chrome's search widget carries voice, Lens and Incognito; Lens has no counterpart here, so
 * the row holds the two.
 *
 * Each face part's `PendingIntent` aims straight at `MainActivity` with the landing as its one
 * extra: a widget's intent is fired as built (unlike a manifest shortcut's, which the system
 * stamps with `FLAG_ACTIVITY_CLEAR_TASK` and which therefore rides the `LauncherIconActivity`
 * trampoline), and the activity is `singleTask`, so a running window hears it in `onNewIntent` and
 * a cold one in `onCreate` – both through the same read (`handleIntent`). The three intents differ
 * by request code ([Face.requestCode]; `Intent.filterEquals` ignores extras, so equal codes would
 * fold them into one `PendingIntent` carrying the last extra written).
 *
 * The face is stateless – no update period, nothing to refresh – so `onUpdate` only rebuilds the
 * views (the launcher asks on placement, on a resize, on the theme changing, after an update).
 */
class SearchWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        val views = views(context)
        for (id in appWidgetIds) appWidgetManager.updateAppWidget(id, views)
    }

    /** A tappable part of the face and the landing it asks for. */
    data class Face(val viewId: Int, val landing: String, val requestCode: Int)

    companion object {
        /** The face's parts in the layout's order: the pill itself, the mic, the mask. */
        val FACES: List<Face> = listOf(
            Face(R.id.widget_search_face, Landing.SEARCH, 1),
            Face(R.id.widget_search_mic, Landing.VOICE, 2),
            Face(R.id.widget_search_private, Landing.PRIVATE, 3)
        )

        /** The face as the launcher shows it, every part wired to its landing. */
        fun views(context: Context): RemoteViews =
            RemoteViews(context.packageName, R.layout.widget_search).apply {
                for (face in FACES) setOnClickPendingIntent(face.viewId, pendingIntent(context, face))
            }

        /**
         * The intent a face part fires: `MainActivity` by component, in the browser's task, with
         * the landing as its extra – what `am start -n <package>/app.zen.chromium.MainActivity
         * --es app.zen.chromium.extra.LANDING <state>` replays for a driver.
         */
        fun intent(context: Context, landing: String): Intent =
            Intent(context, MainActivity::class.java)
                .setAction(Intent.ACTION_MAIN)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(Landing.EXTRA, landing)

        private fun pendingIntent(context: Context, face: Face): PendingIntent =
            PendingIntent.getActivity(
                context,
                face.requestCode,
                intent(context, face.landing),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
    }
}
