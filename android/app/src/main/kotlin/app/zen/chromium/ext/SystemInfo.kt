package app.zen.chromium.ext

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * `chrome.system.cpu` and `chrome.system.memory` on the phone (`ext.system.cpu`,
 * `ext.system.memory`): the readings the core shapes into Chrome's `CpuInfo` and `MemoryInfo`
 * (`core/extensions/api/systemInfo.ts`, which also gates them on the permissions).
 *
 * The processors: `Runtime.availableProcessors()` for the count, Java's `os.arch` for the
 * architecture (the kernel's machine name, what Chrome's `SysInfo` reads), `/proc/cpuinfo` for
 * the model (`model name` on x86, the `Hardware` line on ARM as `base::CPU` falls back to) and
 * the x86 feature flags, `/proc/stat` for the per-processor times. The app's sandbox keeps
 * `/proc/stat` from an untrusted app since Android 8 and may keep `/proc/cpuinfo` too; what
 * cannot be read is left out (`usage` null, the model from `Build`), and the core fills the
 * shape with zeros. The memory: `ActivityManager.MemoryInfo.totalMem` and `availMem`, bytes.
 */
object SystemInfo {
    /** The x86 features Chrome's `CpuInfoProvider` lists, in its order; Linux spells SSE3 `pni`. */
    private val FEATURES = listOf("mmx", "sse", "sse2", "sse3", "ssse3", "sse4_1", "sse4_2", "avx")

    /** The model and the features a `/proc/cpuinfo` text names. */
    class CpuText(val modelName: String, val features: List<String>)

    /** `/proc/cpuinfo`: the first `model name` (x86) or `Hardware` (ARM) as the model, the first `flags` line as the features. */
    fun parseCpuInfo(text: String): CpuText {
        var modelName = ""
        var hardware = ""
        var features: List<String> = emptyList()
        for (line in text.lineSequence()) {
            val colon = line.indexOf(':')
            if (colon < 0) continue
            val key = line.substring(0, colon).trim().lowercase()
            val value = line.substring(colon + 1).trim()
            when {
                key == "model name" && modelName.isEmpty() -> modelName = value
                key == "hardware" && hardware.isEmpty() -> hardware = value
                key == "flags" && features.isEmpty() -> features = featuresOf(value)
            }
        }
        return CpuText(modelName.ifEmpty { hardware }, features)
    }

    /** Chrome's feature names present in a `flags` line, in Chrome's order. */
    fun featuresOf(flags: String): List<String> {
        val present = flags.split(Regex("\\s+")).map { it.lowercase() }.toHashSet()
        if ("pni" in present) present.add("sse3")
        return FEATURES.filter { it in present }
    }

    /**
     * `/proc/stat`: each `cpuN` line's `[user + nice, system, idle]` in processor order as Chrome's
     * Linux provider reads them; a processor missing from the numbering reads as no time counted.
     * Null for a text with no `cpuN` line (the sandbox's `Permission denied`, an empty read).
     */
    fun parseProcStat(text: String): List<LongArray>? {
        val byIndex = HashMap<Int, LongArray>()
        var max = -1
        for (line in text.lineSequence()) {
            val m = STAT_LINE.matchEntire(line.trimEnd()) ?: continue
            val index = m.groupValues[1].toInt()
            val user = m.groupValues[2].toLong() + m.groupValues[3].toLong()
            byIndex[index] = longArrayOf(user, m.groupValues[4].toLong(), m.groupValues[5].toLong())
            if (index > max) max = index
        }
        if (max < 0) return null
        return List(max + 1) { byIndex[it] ?: longArrayOf(0, 0, 0) }
    }

    private val STAT_LINE = Regex("^cpu(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)(?:\\s.*)?$")

    /** The reading as the core takes it: `{ numOfProcessors, archName, modelName, features, usage }`. */
    fun cpuReading(
        processors: Int,
        arch: String,
        cpuInfoText: String?,
        procStatText: String?,
        fallbackModel: String
    ): JSONObject {
        val parsed = cpuInfoText?.let { parseCpuInfo(it) }
        val usage = procStatText?.let { parseProcStat(it) }
        val out = JSONObject()
            .put("numOfProcessors", processors.coerceAtLeast(1))
            .put("archName", arch)
            .put("modelName", parsed?.modelName?.ifEmpty { fallbackModel } ?: fallbackModel)
            .put("features", JSONArray(parsed?.features ?: emptyList<String>()))
        if (usage == null) out.put("usage", JSONObject.NULL)
        else out.put("usage", JSONArray().also { array -> usage.forEach { array.put(JSONArray().put(it[0]).put(it[1]).put(it[2])) } })
        return out
    }

    /** The phone's processors, read now (file IO: off the main thread). */
    fun cpu(): JSONObject = cpuReading(
        Runtime.getRuntime().availableProcessors(),
        System.getProperty("os.arch") ?: "",
        readProc("/proc/cpuinfo"),
        readProc("/proc/stat"),
        socModel()
    )

    /** The phone's memory as `ActivityManager` reports it: `{ capacity, availableCapacity }`, bytes. */
    fun memory(context: Context): JSONObject {
        val info = ActivityManager.MemoryInfo()
        (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(info)
        return JSONObject().put("capacity", info.totalMem).put("availableCapacity", info.availMem)
    }

    /** The SoC's model when the build names it (API 31), else the board's hardware name. */
    private fun socModel(): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val soc = Build.SOC_MODEL
            if (soc.isNotEmpty() && soc != Build.UNKNOWN) return soc
        }
        return Build.HARDWARE.takeIf { it != Build.UNKNOWN } ?: ""
    }

    /** A `/proc` file's text, or null where the sandbox refuses it. */
    private fun readProc(path: String): String? = runCatching { File(path).readText() }.getOrNull()
}
