package app.zen.chromium.privacy

/**
 * Hosts that are not unique on the public Internet, so no public certificate can name them and
 * HTTPS-only mode leaves them alone (the Kotlin twin of `src/shared/nonUniqueHost.ts`; a vitest
 * holds the tables below to the TypeScript ones): loopback (`localhost`, `*.localhost`,
 * `127/8`, `::1`), IP literals in the IANA special-purpose blocks that are not publicly
 * routable, and names without a registrable suffix (single-label names and the special-use
 * suffixes local networks are given).
 *
 * Read by [PrivacyFlags.plaintextAllowed] on the HTTPS-only upgrade path and by the engine for a
 * rule's `excludedNonUniqueHosts` condition. Pure; `host` is a hostname as `Domains.hostnameOf`
 * yields it (any case, an IPv6 literal with or without its brackets, no port). Anything
 * unparsable is unique, so a malformed host is still upgraded.
 */
object NonUniqueHost {
    // BEGIN NON_REGISTRABLE_SUFFIXES (mirrors nonUniqueHost.ts)
    private val NON_REGISTRABLE_SUFFIXES = listOf(
        "localhost", "local", "internal", "test", "invalid", "home.arpa",
        "lan", "home", "corp", "intranet", "private", "localdomain"
    )
    // END NON_REGISTRABLE_SUFFIXES

    // BEGIN RESERVED_IPV4 (mirrors nonUniqueHost.ts)
    private val RESERVED_IPV4 = listOf(
        "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
        "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16",
        "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"
    )
    // END RESERVED_IPV4

    // BEGIN RESERVED_IPV6 (mirrors nonUniqueHost.ts)
    private val RESERVED_IPV6 = listOf(
        "::/128", "::1/128", "100::/64", "2001:db8::/32", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8"
    )
    // END RESERVED_IPV6

    // BEGIN IPV4_CARRIER_IPV6 (mirrors nonUniqueHost.ts)
    /** Prefixes whose last four bytes are an IPv4 address the answer comes from (mapped, NAT64). */
    private val IPV4_CARRIER_IPV6 = listOf("::ffff:0:0/96", "64:ff9b::/96")
    // END IPV4_CARRIER_IPV6

    private val HOSTNAME = Regex("^[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*$")
    private val HEX_GROUP = Regex("^[0-9a-f]{1,4}$", RegexOption.IGNORE_CASE)
    private val IPV6_CHARS = Regex("^[0-9a-f:.]+$", RegexOption.IGNORE_CASE)

    private class Block(val prefix: ByteArray, val bits: Int)

    private val IPV4_BLOCKS = RESERVED_IPV4.map { block(it, ::parseIpv4) }
    private val IPV6_BLOCKS = RESERVED_IPV6.map { block(it, ::parseIpv6) }
    private val CARRIER_BLOCKS = IPV4_CARRIER_IPV6.map { block(it, ::parseIpv6) }

    /** Whether `host` is loopback, a non-publicly-routable IP literal, or a name without a registrable suffix. */
    fun isNonUnique(host: String): Boolean {
        var name = host.trim().lowercase()
        if (name.endsWith(".") && name.length > 1) name = name.dropLast(1)
        if (name.startsWith("[") && name.endsWith("]")) name = name.substring(1, name.length - 1)
        if (name.isEmpty()) return false
        parseIpv4(name)?.let { return isReservedIpv4(it) }
        parseIpv6(name)?.let { return isReservedIpv6(it) }
        if (!HOSTNAME.matches(name)) return false
        return !name.contains('.') || NON_REGISTRABLE_SUFFIXES.any { name.endsWith(".$it") }
    }

    private fun isReservedIpv4(address: ByteArray): Boolean = IPV4_BLOCKS.any { inBlock(address, it) }

    private fun isReservedIpv6(address: ByteArray): Boolean {
        for (carrier in CARRIER_BLOCKS) if (inBlock(address, carrier)) return isReservedIpv4(address.copyOfRange(12, 16))
        return IPV6_BLOCKS.any { inBlock(address, it) }
    }

    private fun block(cidr: String, parse: (String) -> ByteArray?): Block {
        val slash = cidr.indexOf('/')
        val prefix = parse(cidr.substring(0, slash)) ?: throw IllegalArgumentException("Malformed address block $cidr")
        return Block(prefix, cidr.substring(slash + 1).toInt())
    }

    private fun inBlock(address: ByteArray, block: Block): Boolean {
        if (address.size != block.prefix.size) return false
        val whole = block.bits shr 3
        for (i in 0 until whole) if (address[i] != block.prefix[i]) return false
        val rest = block.bits and 7
        if (rest == 0) return true
        val mask = (0xff shl (8 - rest)) and 0xff
        return (address[whole].toInt() and mask) == (block.prefix[whole].toInt() and mask)
    }

    /** Dotted-decimal IPv4: four octets in range; anything else is not an address. */
    fun parseIpv4(text: String): ByteArray? {
        val parts = text.split('.')
        if (parts.size != 4) return null
        val out = ByteArray(4)
        for (i in 0 until 4) {
            val part = parts[i]
            if (part.isEmpty() || part.length > 3 || !part.all { it in '0'..'9' }) return null
            val value = part.toInt()
            if (value > 255) return null
            out[i] = value.toByte()
        }
        return out
    }

    /** RFC 4291 text (`::1`, `fe80::1%eth0` without its zone, `::ffff:192.168.0.1`), one `::` at most. */
    fun parseIpv6(text: String): ByteArray? {
        val zone = text.indexOf('%')
        val literal = if (zone == -1) text else text.substring(0, zone)
        if (!IPV6_CHARS.matches(literal) || !literal.contains(':')) return null
        val gap = literal.indexOf("::")
        if (gap != -1 && literal.indexOf("::", gap + 1) != -1) return null
        val head = if (gap == -1) literal else literal.substring(0, gap)
        val tail = if (gap == -1) "" else literal.substring(gap + 2)
        val headGroups = groups(head) ?: return null
        val tailGroups = groups(tail) ?: return null
        val given = headGroups.size + tailGroups.size
        if (if (gap == -1) given != 8 else given > 7) return null
        val filled = headGroups + List(8 - given) { 0 } + tailGroups
        val out = ByteArray(16)
        filled.forEachIndexed { i, group ->
            out[i * 2] = (group shr 8).toByte()
            out[i * 2 + 1] = (group and 0xff).toByte()
        }
        return out
    }

    /** The 16-bit groups of one side of a `::`; an embedded dotted IPv4 (last only) counts as two. */
    private fun groups(side: String): List<Int>? {
        if (side.isEmpty()) return emptyList()
        val out = ArrayList<Int>(8)
        val parts = side.split(':')
        for ((i, part) in parts.withIndex()) {
            if (part.contains('.')) {
                if (i != parts.size - 1) return null
                val v4 = parseIpv4(part) ?: return null
                out.add(((v4[0].toInt() and 0xff) shl 8) or (v4[1].toInt() and 0xff))
                out.add(((v4[2].toInt() and 0xff) shl 8) or (v4[3].toInt() and 0xff))
                continue
            }
            if (!HEX_GROUP.matches(part)) return null
            out.add(part.toInt(16))
        }
        return out
    }
}
