package app.zen.chromium.privacy

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The twin of `src/shared/__tests__/nonUniqueHost.test.ts`: the same hosts, the same answers. */
class NonUniqueHostTest {
    private fun nonUnique(vararg hosts: String) = hosts.forEach { assertTrue(it, NonUniqueHost.isNonUnique(it)) }
    private fun unique(vararg hosts: String) = hosts.forEach { assertFalse(it, NonUniqueHost.isNonUnique(it)) }

    @Test
    fun `loopback - localhost, every star-dot-localhost, 127 slash 8 and colon-colon-1`() {
        nonUnique(
            "localhost", "LOCALHOST", "localhost.", "dev.localhost", "a.b.localhost",
            "127.0.0.1", "127.1.2.3", "[::1]", "::1", "[0:0:0:0:0:0:0:1]", "[::ffff:127.0.0.1]"
        )
    }

    @Test
    fun `the IPv4 blocks that are not publicly routable, and no others`() {
        nonUnique(
            "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254",
            "169.254.1.1", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.88.99.1",
            "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1",
            "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255"
        )
        unique(
            "1.1.1.1", "8.8.8.8", "9.255.255.255", "11.0.0.1", "100.63.255.255", "100.128.0.1",
            "126.255.255.255", "128.0.0.1", "169.253.1.1", "169.255.1.1", "172.15.255.255", "172.32.0.1",
            "192.0.1.1", "192.0.3.1", "192.88.98.1", "192.167.1.1", "192.169.1.1", "198.17.255.255",
            "198.20.0.1", "198.51.101.1", "203.0.112.1", "223.255.255.255"
        )
    }

    @Test
    fun `the IPv6 blocks that are not publicly routable, bracketed or not, and no others`() {
        nonUnique(
            "[::]", "[::1]", "[100::1]", "[2001:db8::1]", "[2001:DB8:0:0:0:0:0:1]", "[fc00::1]",
            "[fd12:3456:789a::1]", "[fe80::1]", "[fe80::1%25eth0]", "fe80::1%eth0", "[febf::1]",
            "[fec0::1]", "[ff02::1]",
            // IPv4-mapped and NAT64 addresses answer for the IPv4 address they carry.
            "[::ffff:10.0.0.1]", "[::ffff:a00:1]", "[::ffff:192.168.0.1]", "[64:ff9b::10.0.0.1]", "[64:ff9b::7f00:1]"
        )
        unique(
            "[2606:4700:4700::1111]", "[2001:4860:4860::8888]", "[2001:db7::1]", "[2001:db9::1]", "[fbff::1]",
            "[fe00::1]", "[fe7f::1]", "[ec00::1]", "[::ffff:8.8.8.8]", "[::ffff:808:808]", "[64:ff9b::1.1.1.1]",
            "[100:0:0:1::1]"
        )
    }

    @Test
    fun `single-label hosts and the suffixes no registry delegates`() {
        nonUnique(
            "intranet", "INTRANET", "router.", "nas", "printer.local", "Printer.LOCAL", "api.service.internal",
            "staging.test", "host.invalid", "gateway.home.arpa", "tv.lan", "pc.home", "mail.corp",
            "wiki.intranet", "db.private", "box.localdomain"
        )
    }

    @Test
    fun `public hosts are left alone, however local they look, and the documentation names with them`() {
        unique(
            "example.com", "www.example.com", "example.com.", "EXAMPLE.ORG", "old.example", "www.example",
            "localhost.com", "mylocal.host", "local.example", "notlocal.dev", "example.co.uk",
            "xn--bcher-kva.example", "internal-tools.example.com", "lan.example.net", "test.example.org",
            "a.b.c.d.e.example"
        )
    }

    @Test
    fun `what cannot be parsed is unique, so a malformed host is still upgraded`() {
        unique(
            "", " ", ".", "[", "[]", "300.1.1.1", "1.2.3", "1.2.3.4.5", "[::1", "[1:2:3:4:5:6:7:8:9]",
            "[::1::2]", "[gggg::1]", "[::ffff:300.1.1.1]", "not a host"
        )
    }

    @Test
    fun `the address parsers read dotted decimal and RFC 4291 text into bytes, refusing anything else`() {
        assertArrayEquals(byteArrayOf(192.toByte(), 168.toByte(), 0, 1), NonUniqueHost.parseIpv4("192.168.0.1"))
        assertNull(NonUniqueHost.parseIpv4("192.168.0"))
        assertNull(NonUniqueHost.parseIpv4("192.168.0.256"))
        assertNull(NonUniqueHost.parseIpv4("192.168.0.a"))
        assertNull(NonUniqueHost.parseIpv4("0x7f.0.0.1"))

        val loopback = ByteArray(16).also { it[15] = 1 }
        assertArrayEquals(loopback, NonUniqueHost.parseIpv6("::1"))
        assertArrayEquals(loopback, NonUniqueHost.parseIpv6("0:0:0:0:0:0:0:1"))
        assertArrayEquals(
            byteArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff.toByte(), 0xff.toByte(), 192.toByte(), 168.toByte(), 0, 1),
            NonUniqueHost.parseIpv6("::ffff:192.168.0.1")
        )
        assertArrayEquals(byteArrayOf(0xfe.toByte(), 0x80.toByte()), NonUniqueHost.parseIpv6("fe80::1%eth0")!!.copyOfRange(0, 2))
        assertNull(NonUniqueHost.parseIpv6("1:2:3:4:5:6:7"))
        assertNull(NonUniqueHost.parseIpv6("1:2:3:4:5:6:7:8:9"))
        assertNull(NonUniqueHost.parseIpv6("1::2::3"))
        assertNull(NonUniqueHost.parseIpv6("::12345"))
        assertNull(NonUniqueHost.parseIpv6("1.2.3.4"))
        assertNull(NonUniqueHost.parseIpv6("::1.2.3.4:5"))
    }
}
