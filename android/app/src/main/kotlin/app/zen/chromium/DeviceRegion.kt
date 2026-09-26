package app.zen.chromium

import android.content.Context
import android.telephony.TelephonyManager
import android.util.Log
import java.util.Locale

/**
 * The device's region for the EEA's search-engine choice screen (OMN-26; the shared model
 * `src/core/searchChoice.ts` gates the screen on `PlatformInfo.region`): ISO 3166-1 alpha-2 in
 * upper case, or null when nothing on the device names one – and a device that names none is
 * never in the EEA.
 *
 * The order is the network's country first (`TelephonyManager.networkCountryIso`: where the
 * device is right now, a roaming user included – the regulation asks after the user's location),
 * then the SIM's (`simCountryIso`: the user's home market, when the device has no network at
 * boot), then the default locale's region (`Locale.getDefault().country`: the one answer a
 * device without telephony – a Wi-Fi tablet – still has; Chrome's open-source path reads this one
 * alone, `LocaleUtils.getDefaultCountryCode`, its branded build the Play Services device country
 * that the network and the SIM inform). One `TelephonyManager` lookup per boot, nothing cached
 * across runs: a device moved into the Area is asked at its next run, as Chrome asks.
 *
 * The tester's override stands in the OS's place, as the desktop's `--zen-region=DE` /
 * `ZEN_REGION` does (`PlatformInfo.region`'s doc): `adb shell setprop debug.zenium.region DE`,
 * read through `SystemProperties` by reflection, honoured by DEBUGGABLE builds alone (a release
 * build reads the device). `debug.zenium.region -` names "no region" (a device outside the Area
 * without a country), so a run can prove the gate closed. The property is the shell's to set and
 * survives the app's relaunch, so a driver's second launch sees the same region.
 */
object DeviceRegion {
    private const val TAG = "DeviceRegion"

    /** The system property a debuggable build reads first. */
    const val OVERRIDE_PROPERTY = "debug.zenium.region"

    /** The override's word for "no region": the device names no country. */
    const val OVERRIDE_NONE = "-"

    /**
     * The region resolved from what the device says, pure: `override` (a debuggable build's
     * property, null on a release build or when unset) over the network's country over the SIM's
     * over the locale's. Each answer is normalised to two upper-case letters; an answer of another
     * shape (empty, `"---"`, a three-letter code) is passed over for the next.
     */
    fun resolve(override: String?, networkCountry: String?, simCountry: String?, localeCountry: String?): String? {
        if (override != null) {
            val word = override.trim()
            if (word == OVERRIDE_NONE) return null
            normalize(word)?.let { return it }
        }
        return normalize(networkCountry) ?: normalize(simCountry) ?: normalize(localeCountry)
    }

    /** Two letters, upper-cased, or null. */
    fun normalize(raw: String?): String? {
        val code = raw?.trim()?.uppercase(Locale.ROOT) ?: return null
        return if (code.length == 2 && code.all { it in 'A'..'Z' }) code else null
    }

    /**
     * The device's region: one `TelephonyManager` read (the network's, then the SIM's country when
     * the network names none), the locale last; the override first on a debuggable build. Cheap
     * enough for the boot payload (`Host.dispatchSync("boot")`): two binder calls at most, no I/O.
     */
    fun read(context: Context, debuggable: Boolean): String? {
        val override = if (debuggable) overrideProperty() else null
        // The override answers on its own when it names a region or "none": the telephony reads
        // are skipped so a driver's run never depends on the emulator's simulated network.
        if (override != null && (override.trim() == OVERRIDE_NONE || normalize(override) != null)) {
            return resolve(override, null, null, null)
        }
        val telephony = try {
            context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        } catch (e: RuntimeException) {
            Log.w(TAG, "no telephony service: ${e.message}")
            null
        }
        val network = telephony?.let { safeCountry { it.networkCountryIso } }
        val sim = if (normalize(network) == null) telephony?.let { safeCountry { it.simCountryIso } } else null
        return resolve(null, network, sim, Locale.getDefault().country)
    }

    private inline fun safeCountry(read: () -> String?): String? = try {
        read()
    } catch (e: RuntimeException) {
        Log.w(TAG, "telephony country unreadable: ${e.message}")
        null
    }

    /**
     * `debug.zenium.region` through `android.os.SystemProperties.get(String)` (a hidden class; the
     * reflection is the debug path's alone). Null when unset or unreadable.
     */
    fun overrideProperty(): String? = try {
        val clazz = Class.forName("android.os.SystemProperties")
        val get = clazz.getMethod("get", String::class.java)
        (get.invoke(null, OVERRIDE_PROPERTY) as? String)?.takeIf { it.isNotBlank() }
    } catch (e: Exception) {
        Log.w(TAG, "override property unreadable: ${e.message}")
        null
    }
}
