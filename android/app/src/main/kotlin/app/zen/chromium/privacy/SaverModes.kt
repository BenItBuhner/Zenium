package app.zen.chromium.privacy

import android.content.Context
import android.net.ConnectivityManager
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log

/**
 * The system's saver modes as Chrome Android reads them for its preloading (OS-21). Chrome's own
 * Data Saver went with M100; what Chrome 152 keeps is `prefetch::IsSomePreloadingEnabled`
 * (`chrome/browser/preloading/preloading_prefs.cc:60-76`): after Preload pages `none`, the OS
 * Data Saver makes every preload ineligible (`kDataSaverEnabled`), then the OS Battery Saver
 * (`kBatterySaverEnabled`) – nothing else changes on the phone (no UI, no throttling; the
 * desktop's Energy Saver is `!is_android`). Data Saver is `isActiveNetworkMetered() &&
 * getRestrictBackgroundStatus() == RESTRICT_BACKGROUND_STATUS_ENABLED`
 * (`DataSaverOSSetting.java:25-27`): an unmetered network, or this app allowlisted for
 * unrestricted data (`WHITELISTED`), reads as no Data Saver. Battery Saver is
 * `PowerManager.isPowerSaveMode()` (`BatterySaverOSSetting.java:34`). Chrome registers no
 * receiver for either – it polls, the Data Saver reading cached for one second
 * (`data_saver.cc:71`) – and so does this.
 */
enum class SaverState {
    /** Neither mode is on: a preload is eligible (Chrome's `kEligible`). */
    NONE,
    /** The system's Data Saver restricts this app's data on a metered network (Chrome's `kDataSaverEnabled`). */
    DATA_SAVER,
    /** The system's Battery Saver is on (Chrome's `kBatterySaverEnabled`). */
    BATTERY_SAVER;

    /** Whether Chrome holds every preload under this state (`IsSomePreloadingEnabled` other than `kEligible`). */
    val refusesPreloading: Boolean get() = this != NONE
}

/** The mapping, free of Android calls for the JVM tests: the readings in, Chrome's state out. */
object SaverRules {
    /**
     * Chrome's order and short-circuits (`preloading_prefs.cc:67-73`, `DataSaverOSSetting.java:25-27`):
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
 * marked request. The readers are handed in so the JVM tests drive the clock and the system.
 */
class SaverModes internal constructor(
    private val metered: () -> Boolean,
    private val restrictBackgroundStatus: () -> Int,
    private val powerSaveMode: () -> Boolean,
    private val now: () -> Long,
) {
    @Volatile
    private var cached: SaverState = SaverState.NONE

    @Volatile
    private var readAt: Long = 0L

    @Volatile
    private var read = false

    /**
     * The state as of the last second. A system service that fails to answer reads as [SaverState.NONE]
     * (Chrome's word when its power manager is missing), and that answer stands for the second too.
     */
    fun state(): SaverState {
        val at = now()
        if (read && at - readAt < TTL_MS) return cached
        val fresh = runCatching { SaverRules.stateOf(metered, restrictBackgroundStatus, powerSaveMode) }
            .getOrElse { e ->
                Log.w(TAG, "saver modes not read", e)
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
