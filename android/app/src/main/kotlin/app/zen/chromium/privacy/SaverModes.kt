package app.zen.chromium.privacy

import android.content.Context
import android.net.ConnectivityManager
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log

/**
 * The system's saver modes as Chrome Android reads them for its preloading (OS-21). Chrome's own
 * Data Saver (Lite mode) was turned down in M100, its code removed by `f5052f5e94d6`
 * (2022-04-20, bug 1278547); what Chrome 152 keeps is `prefetch::IsSomePreloadingEnabled`
 * (`chrome/browser/preloading/preloading_prefs.cc:60-77`): after Preload pages `none`
 * (`:64-66`), the OS Data Saver makes the pages' preloads ineligible (`kDataSaverEnabled`,
 * `:68-70`), then the OS Battery Saver (`kBatterySaverEnabled`, `:71-73`) – nothing else
 * changes on the phone (no UI, no throttling; the desktop's Energy Saver is `!is_android`).
 * One preload is excepted: the omnibox's on-press search prefetch ignores both modes
 * (`kSearchPrefetchIgnoreSaverModesOnPress`, on by default on Android,
 * `chrome/browser/preloading/prefetch/search_prefetch/field_trial_settings.cc:103-109`;
 * `search_prefetch_service.cc:829-849`, the arrow-key prediction keeps the hold) – nothing to
 * exempt here, this omnibox does no search prefetch. And Chrome never gates `<link rel=prefetch>`
 * by the modes (`third_party/blink/renderer/core/loader/preload_helper.cc:795-863`); what that
 * means from WebView 138 is [PreloadRules]' to say. Data Saver is `isActiveNetworkMetered() &&
 * getRestrictBackgroundStatus() == RESTRICT_BACKGROUND_STATUS_ENABLED`
 * (`chrome/android/java/.../datareduction/DataSaverOSSetting.java:25-29`): an unmetered network,
 * or this app allowlisted for unrestricted data (`WHITELISTED`), reads as no Data Saver. Battery
 * Saver is `PowerManager.isPowerSaveMode()`
 * (`chrome/browser/battery/android/java/.../BatterySaverOSSetting.java:34`). Chrome registers no
 * receiver for either – it polls, the Data Saver reading cached for one second
 * (`chrome/browser/data_saver/data_saver.cc:71-74`) – and so does this.
 */
enum class SaverState {
    /** Neither mode is on: a preload is eligible (Chrome's `kEligible`). */
    NONE,
    /** The system's Data Saver restricts this app's data on a metered network (Chrome's `kDataSaverEnabled`). */
    DATA_SAVER,
    /** The system's Battery Saver is on (Chrome's `kBatterySaverEnabled`). */
    BATTERY_SAVER;

    /** Whether Chrome holds the pages' preloads under this state (`IsSomePreloadingEnabled` other than `kEligible`). */
    val refusesPreloading: Boolean get() = this != NONE
}

/** The mapping, free of Android calls for the JVM tests: the readings in, Chrome's state out. */
object SaverRules {
    /**
     * Chrome's order and short-circuits (`preloading_prefs.cc:67-73`, `DataSaverOSSetting.java:25-29`):
     * the restrict-background status is asked only on a metered network, the power manager only
     * when Data Saver is not on; Data Saver wins when both are on.
     */
    fun stateOf(metered: () -> Boolean, restrictBackgroundStatus: () -> Int, powerSaveMode: () -> Boolean): SaverState = when {
        metered() && restrictBackgroundStatus() == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED -> SaverState.DATA_SAVER
        powerSaveMode() -> SaverState.BATTERY_SAVER
        else -> SaverState.NONE
    }
}

/**
 * The process's reading of both modes, for the request engine's prefetch refusal
 * ([PreloadRules.refuses]): read on WebView's network threads for a marked request alone, at
 * most once per [TTL_MS] – three binder calls at most in that second, none for a page's own
 * requests. Nothing is registered and nothing runs at boot: [shared] is created by the first
 * marked request. The readers are handed in so the JVM tests drive the clock and the system, and
 * the warning too (`android.util.Log` is a stub on the JVM).
 */
class SaverModes internal constructor(
    private val metered: () -> Boolean,
    private val restrictBackgroundStatus: () -> Int,
    private val powerSaveMode: () -> Boolean,
    private val now: () -> Long,
    private val warn: (Throwable) -> Unit = { Log.w(TAG, "saver modes not read", it) },
) {
    @Volatile
    private var cached: SaverState = SaverState.NONE

    @Volatile
    private var readAt: Long = 0L

    @Volatile
    private var read = false

    /**
     * The state as of the last second. A system service that fails to answer reads as [SaverState.NONE]
     * (Chrome's word when its power manager is missing) – warned, not thrown, the other reader not
     * consulted in its place – and that answer stands for the second too.
     */
    fun state(): SaverState {
        val at = now()
        if (read && at - readAt < TTL_MS) return cached
        val fresh = runCatching { SaverRules.stateOf(metered, restrictBackgroundStatus, powerSaveMode) }
            .getOrElse { e ->
                warn(e)
                SaverState.NONE
            }
        cached = fresh
        readAt = at
        read = true
        return fresh
    }

    companion object {
        private const val TAG = "zen-saver"

        /** How long a reading stands before a marked request asks the system again (Chrome's `base::Seconds(1)`). */
        const val TTL_MS = 1_000L

        @Volatile
        private var sharedInstance: SaverModes? = null

        /** The process's reader over the system's managers, created on first use. */
        fun shared(context: Context): SaverModes {
            sharedInstance?.let { return it }
            synchronized(this) {
                sharedInstance?.let { return it }
                val app = context.applicationContext
                val connectivity = app.getSystemService(ConnectivityManager::class.java)
                val power = app.getSystemService(PowerManager::class.java)
                return SaverModes(
                    metered = { connectivity?.isActiveNetworkMetered == true },
                    restrictBackgroundStatus = { connectivity?.restrictBackgroundStatus ?: ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED },
                    powerSaveMode = { power?.isPowerSaveMode == true },
                    now = SystemClock::elapsedRealtime,
                ).also { sharedInstance = it }
            }
        }
    }
}
