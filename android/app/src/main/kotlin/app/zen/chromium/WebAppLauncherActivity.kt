package app.zen.chromium

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/**
 * What an installed app's home-screen tile starts (PWA-07): gone before it draws
 * (`Theme.NoDisplay`, no history, out of Recents, its own empty affinity), it reads the
 * manifest's record from the tile's intent and opens [WebAppActivity] in the app's own task –
 * Chrome's `WebappLauncherActivity` before its `WebappActivity`. The indirection is the one
 * [LauncherIconActivity] documents: the system may stamp a shortcut's launch with
 * `FLAG_ACTIVITY_CLEAR_TASK`, which here clears only this trampoline's task; and a tile whose
 * intent carries no record – pinned before the record existed, or a `browser` app – goes on to
 * `MainActivity` as a tab, exactly as it did (`Shortcuts.launchIntent`).
 *
 * Not exported: the system starts pinned shortcuts under their creator's uid, so the tile reaches
 * it and another app's intent does not (Chrome's `SecureWebAppLauncher`).
 */
class WebAppLauncherActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val record = WebAppRecord.fromIntent(intent)
        val url = intent?.dataString?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
        if (record == null || url == null) {
            startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(url ?: record?.startUrl ?: "about:blank"))
                    .setClass(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } else {
            startActivity(launchIntent(this, record, url))
        }
        finish()
    }

    companion object {
        /**
         * The intent that opens `record`'s window at `url`: its `data` names the app's task
         * ([WebAppRules.taskUri]) so `documentLaunchMode="intoExisting"` lands a second launch in
         * the first's task, and `CLEAR_TOP` hands that running window the intent (`onNewIntent`)
         * rather than swallowing it – Chrome's flags (`WebappLauncherActivity.createIntentToLaunchForWebapp`).
         */
        fun launchIntent(context: Context, record: WebAppRecord, url: String): Intent =
            record.putInto(
                Intent(Intent.ACTION_VIEW, Uri.parse(WebAppRules.taskUri(record.shortcutId)))
                    .setClass(context, WebAppActivity::class.java)
                    .putExtra(WebAppActivity.EXTRA_URL, url)
                    .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NEW_DOCUMENT or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            )
    }
}
