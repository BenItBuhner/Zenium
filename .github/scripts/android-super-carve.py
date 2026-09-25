#!/usr/bin/env python3
"""Carve one logical partition out of an Android system image read as a stream.

Google's x86_64 system images (the SDK's `system-images;android-<n>;google_apis;x86_64` zips)
ship `system.img` as a GPT disk with one `super` partition, and the logical partitions (system,
system_ext, product, vendor, ...) inside it laid out by liblp's metadata. This reads the disk
from stdin – the zip member piped straight in (`unzip -p`), never extracted whole – parses the
GPT for `super`, then liblp's metadata at super's head for the named partition's extents, and
writes those bytes to the output file, so that `debugfs` can read the one file wanted out of it
(android-webview-google.sh: the product partition's WebViewGoogle.apk.gz). Nothing seeks: the
stream is read forward once, skipped where nothing is wanted.

  unzip -p image.zip x86_64/system.img | android-super-carve.py product product.img

The layout read (liblp, system/core/fs_mgr/liblp/include/liblp/metadata_format.h): the geometry
block at super + 4096 (a backup at + 8192), the first metadata slot at super + 12288 – a header
(magic 0x414C5030 'LP\\x30\\x41', version, header size, the tables' size) followed by its tables;
the header's descriptors (offset, count, entry size) place the partition table (name[36],
attributes, first extent, extent count, group) and the extent table (sectors, target type,
target data, source) inside the tables. A LINEAR extent's target data is its first sector
within the super partition; a ZERO extent reads as zeros. A partition whose extents are not in
increasing physical order cannot come off a stream, and the script says so rather than guess.
"""

import struct
import sys

LP_MAGIC = 0x414C5030
LP_METADATA_OFFSET = 12288  # LP_PARTITION_RESERVED_BYTES + 2 * LP_METADATA_GEOMETRY_SIZE
SECTOR = 512
CHUNK = 8 << 20


class Stream:
    """A forward-only reader over stdin's bytes with a running offset."""

    def __init__(self, source):
        self.source = source
        self.offset = 0

    def read(self, count):
        parts = []
        left = count
        while left > 0:
            piece = self.source.read(min(left, CHUNK))
            if not piece:
                break
            parts.append(piece)
            left -= len(piece)
        data = b"".join(parts)
        self.offset += len(data)
        if len(data) != count:
            raise EOFError(f"the image ended at {self.offset} bytes, {count - len(data)} short of a read")
        return data

    def skip_to(self, offset):
        if offset < self.offset:
            raise ValueError(f"cannot go back from {self.offset} to {offset} on a stream")
        while self.offset < offset:
            piece = self.source.read(min(offset - self.offset, CHUNK))
            if not piece:
                raise EOFError(f"the image ended at {self.offset} bytes, before {offset}")
            self.offset += len(piece)

    def copy_to(self, sink, count):
        left = count
        while left > 0:
            piece = self.source.read(min(left, CHUNK))
            if not piece:
                raise EOFError(f"the image ended at {self.offset} bytes, {left} short of the partition")
            sink.write(piece)
            self.offset += len(piece)
            left -= len(piece)

    def drain(self):
        """Read the rest of the stream: a producer cut short (`unzip -p` under SIGPIPE) would fail the pipeline."""
        while True:
            piece = self.source.read(CHUNK)
            if not piece:
                return
            self.offset += len(piece)


def gpt_partitions(head):
    """(name, first byte, length) of every GPT entry in `head` (the disk's first bytes; 512-byte LBAs)."""
    if head[SECTOR : SECTOR + 8] != b"EFI PART":
        raise ValueError("no GPT header at LBA 1 (not a 512-byte-sector GPT disk)")
    entries_lba, count, entry_size = struct.unpack_from("<QII", head, SECTOR + 72)
    base = entries_lba * SECTOR
    if base + count * entry_size > len(head):
        raise ValueError("the GPT entries lie past the bytes read")
    found = []
    for i in range(count):
        entry = head[base + i * entry_size : base + (i + 1) * entry_size]
        if entry[:16] == b"\0" * 16:
            continue
        first_lba, last_lba = struct.unpack_from("<QQ", entry, 32)
        name = entry[56:128].decode("utf-16le").rstrip("\0")
        found.append((name, first_lba * SECTOR, (last_lba - first_lba + 1) * SECTOR))
    return found


def lp_extents(header, tables, name):
    """[(byte offset within super, length, kind)] of partition `name`; kind LINEAR or ZERO."""
    magic, _major, _minor, header_size, _checksum, tables_size = struct.unpack_from("<IHHI32sI", header, 0)
    if magic != LP_MAGIC:
        raise ValueError(f"no liblp metadata at super + {LP_METADATA_OFFSET} (magic {magic:#x})")
    if len(tables) < tables_size:
        raise ValueError("the metadata tables lie past the bytes read")
    partitions = struct.unpack_from("<III", header, 80)
    extents = struct.unpack_from("<III", header, 92)

    def entries(descriptor):
        offset, count, size = descriptor
        return [tables[offset + i * size : offset + (i + 1) * size] for i in range(count)]

    extent_table = entries(extents)
    for entry in entries(partitions):
        entry_name = entry[:36].split(b"\0")[0].decode()
        if entry_name != name:
            continue
        _attributes, first, count, _group = struct.unpack_from("<IIII", entry, 36)
        found = []
        for extent in extent_table[first : first + count]:
            sectors, target_type, target_data, _source = struct.unpack_from("<QIQI", extent, 0)
            found.append((target_data * SECTOR, sectors * SECTOR, "LINEAR" if target_type == 0 else "ZERO"))
        return found, header_size
    raise ValueError(f"no partition '{name}' in the liblp metadata")


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: android-super-carve.py <partition> <out file> < system.img\n")
        return 2
    wanted, out_path = argv[1], argv[2]
    stream = Stream(sys.stdin.buffer)
    # The GPT: the header at LBA 1, its entries (128 of 128 bytes by convention) from LBA 2.
    head = stream.read(64 << 10)
    supers = [p for p in gpt_partitions(head) if p[0] == "super"]
    if not supers:
        raise ValueError("no 'super' partition in the GPT")
    _name, super_offset, super_length = supers[0]
    stream.skip_to(super_offset + LP_METADATA_OFFSET)
    # The header: 128 bytes in metadata 10.0, 256 from 10.2 (flags and reserve); the tables follow it.
    header = stream.read(128)
    header_size = struct.unpack_from("<I", header, 8)[0]
    if header_size < 128:
        raise ValueError(f"a liblp header of {header_size} bytes is none")
    if header_size > 128:
        header += stream.read(header_size - 128)
    tables_size = struct.unpack_from("<I", header, 44)[0]
    tables = stream.read(tables_size)
    extents, _ = lp_extents(header, tables, wanted)
    physical = [e for e in extents if e[2] == "LINEAR"]
    if any(b[0] <= a[0] for a, b in zip(physical, physical[1:])):
        raise ValueError(f"'{wanted}' has extents out of physical order; not carvable from a stream")
    total = sum(e[1] for e in extents)
    sys.stderr.write(
        f"super at {super_offset} ({super_length} bytes); {wanted}: {len(extents)} extent(s), {total} bytes\n"
    )
    with open(out_path, "wb") as out:
        for offset, length, kind in extents:
            if kind == "ZERO":
                left = length
                zeros = bytes(CHUNK)
                while left > 0:
                    out.write(zeros[: min(left, CHUNK)])
                    left -= min(left, CHUNK)
                continue
            stream.skip_to(super_offset + offset)
            stream.copy_to(out, length)
    sys.stderr.write(f"wrote {total} bytes to {out_path}\n")
    stream.drain()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except (ValueError, EOFError) as fault:
        sys.stderr.write(f"android-super-carve.py: {fault}\n")
        sys.exit(1)
