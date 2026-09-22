package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SystemInfoTest {
    private val x86CpuInfo = """
        processor	: 0
        vendor_id	: GenuineIntel
        model name	: Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz
        flags		: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss ht syscall nx pdpe1gb rdtscp lm constant_tsc rep_good nopl xtopology pni pclmulqdq ssse3 fma cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt aes xsave avx f16c rdrand hypervisor lahf_lm abm 3dnowprefetch
        processor	: 1
        model name	: Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz
        flags		: fpu vme mmx sse sse2 pni ssse3 sse4_1 sse4_2 avx
    """.trimIndent()

    private val armCpuInfo = """
        processor	: 0
        BogoMIPS	: 38.40
        Features	: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp
        CPU implementer	: 0x41
        CPU part	: 0xd05
        Hardware	: Qualcomm Technologies, Inc SM8550
    """.trimIndent()

    private val procStat = """
        cpu  1200 30 400 9000 50 0 10 0 0 0
        cpu0 500 10 150 4000 20 0 5 0 0 0
        cpu1 700 20 250 5000 30 0 5 0 0 0
        intr 123456 0 0
        ctxt 987654
    """.trimIndent()

    @Test
    fun `cpuinfo gives the x86 model and Chrome's features in Chrome's order, pni read as sse3`() {
        val parsed = SystemInfo.parseCpuInfo(x86CpuInfo)
        assertEquals("Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz", parsed.modelName)
        assertEquals(listOf("mmx", "sse", "sse2", "sse3", "ssse3", "sse4_1", "sse4_2", "avx"), parsed.features)
    }

    @Test
    fun `cpuinfo on ARM names the hardware as the model and lists no x86 feature`() {
        val parsed = SystemInfo.parseCpuInfo(armCpuInfo)
        assertEquals("Qualcomm Technologies, Inc SM8550", parsed.modelName)
        assertTrue(parsed.features.isEmpty())
    }

    @Test
    fun `proc stat gives each processor's user plus nice, system and idle ticks`() {
        val usage = SystemInfo.parseProcStat(procStat)!!
        assertEquals(2, usage.size)
        assertEquals(listOf(510L, 150L, 4000L), usage[0].toList())
        assertEquals(listOf(720L, 250L, 5000L), usage[1].toList())
        assertNull(SystemInfo.parseProcStat(""))
        assertNull(SystemInfo.parseProcStat("cpu  1 2 3 4 5\n"))
    }

    @Test
    fun `a processor missing from the numbering reads as no time counted`() {
        val usage = SystemInfo.parseProcStat("cpu0 1 1 1 1 0\ncpu2 3 3 3 3 0\n")!!
        assertEquals(3, usage.size)
        assertEquals(listOf(0L, 0L, 0L), usage[1].toList())
        assertEquals(listOf(6L, 3L, 3L), usage[2].toList())
    }

    @Test
    fun `the reading carries the count, the arch, the parsed model and features, and the usage`() {
        val reading = SystemInfo.cpuReading(2, "aarch64", armCpuInfo, procStat, "fallback")
        assertEquals(2, reading.getInt("numOfProcessors"))
        assertEquals("aarch64", reading.getString("archName"))
        assertEquals("Qualcomm Technologies, Inc SM8550", reading.getString("modelName"))
        assertEquals(0, reading.getJSONArray("features").length())
        val usage = reading.getJSONArray("usage")
        assertEquals(2, usage.length())
        assertEquals(510L, usage.getJSONArray(0).getLong(0))
    }

    @Test
    fun `what the sandbox keeps from the app is left out, the model falling back to the build's`() {
        val reading = SystemInfo.cpuReading(0, "x86_64", null, null, "ranchu")
        assertEquals(1, reading.getInt("numOfProcessors"))
        assertEquals("ranchu", reading.getString("modelName"))
        assertTrue(reading.isNull("usage"))
        assertEquals(0, reading.getJSONArray("features").length())
    }
}
