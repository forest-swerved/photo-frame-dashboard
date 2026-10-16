#!/usr/bin/env python3
"""Build the PF1007L root-ADB boot patch from YOUR OWN verified eMMC backup.

Usage (from the repository root):
  python3 -I scripts/a33-uboot/boot-patch.py backups/a33-emmc-full.img 172032

The second argument is the boot partition's start sector on your unit. Find it
by parsing your own partition table; do not copy it from another unit.

Writes diagnostics/a33-boot-patch/:
  orig-header.bin, new-header.bin       first sectors of the boot image
  orig-ramdisk.bin, new-ramdisk.bin     the padded ramdisk slot
  plan.json                             sectors, sizes and CRC-32s
  write-boot.cmd / write-boot.scr       guarded U-Boot write script
  restore-boot.cmd / restore-boot.scr   guarded undo: writes the original bytes back

Nothing here touches a device. The U-Boot script only writes when every payload
matches its CRC-32 and the eMMC still holds the original bytes from your backup.
"""

import gzip
import hashlib
import json
import struct
import sys
import time
import zlib
from pathlib import Path

SECTOR = 512
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "diagnostics/a33-boot-patch"

# DRAM load addresses used by write-boot.cmd (U-Boot itself runs from 0x4A000000).
ADDR = {"orig_header": 0x50000000, "orig_ramdisk": 0x51000000,
        "new_header": 0x52000000, "new_ramdisk": 0x53000000,
        "read_header": 0x54000000, "read_ramdisk": 0x55000000}

OLD_ACTION = (b"on property:sys.usb.config=mass_storage\n"
              b"    write /sys/class/android_usb/android0/enable\t0\n"
              b"    write /sys/class/android_usb/android0/idVendor\t1f3a\n"
              b"    write /sys/class/android_usb/android0/idProduct\t1000\n"
              b"    write /sys/class/android_usb/android0/functions\t${sys.usb.config}\n"
              b"    write /sys/class/android_usb/android0/enable \t1\n"
              b"    setprop sys.usb.state ${sys.usb.config}\n")
NEW_ACTION = (b"on property:sys.usb.config=mass_storage\n"
              b"    write /sys/class/android_usb/android0/enable 0\n"
              b"    write /sys/class/android_usb/android0/idVendor 1f3a\n"
              b"    write /sys/class/android_usb/android0/idProduct 1002\n"
              b"    write /sys/class/android_usb/android0/functions mass_storage,adb\n"
              b"    write /sys/class/android_usb/android0/enable 1\n"
              b"    start adbd\n"
              b"    setprop sys.usb.state ${sys.usb.config}\n")


def fail(message):
    sys.exit(f"STOP: {message}")


def partitions(image):
    """MBR primary + extended/logical partitions as (start, sectors)."""
    def entries(block):
        return [(block[446 + i * 16 + 4], *struct.unpack_from("<II", block, 446 + i * 16 + 8))
                for i in range(4)]

    image.seek(0)
    mbr = image.read(SECTOR)
    if mbr[510:] != b"\x55\xaa":
        fail("no MBR signature")
    found, extended = [], None
    for kind, start, count in entries(mbr):
        if kind in (0x05, 0x0F):
            extended = start
        elif kind:
            found.append((start, count))
    ebr = extended
    while ebr is not None:
        image.seek(ebr * SECTOR)
        first, second = entries(image.read(SECTOR))[:2]
        found.append((ebr + first[1], first[2]))
        ebr = extended + second[1] if second[0] else None
    return found


def parse_boot(boot):
    if len(boot) < 2048 or len(boot) % SECTOR:
        fail("boot partition is truncated or not sector-aligned")
    magic, kernel_size, _, ramdisk_size, _, second_size, _, _, page = struct.unpack_from("<8s8I", boot, 0)
    if magic != b"ANDROID!":
        fail("not an Android boot image at that sector")
    if page != 2048 or second_size != 0 or boot[40:44] != bytes(4):
        fail("unexpected page size, second stage or header version")
    pad = lambda n: (n + page - 1) // page * page
    ramdisk_offset = page + pad(kernel_size)
    if not kernel_size or not ramdisk_size or ramdisk_offset + pad(ramdisk_size) > len(boot):
        fail("kernel or padded ramdisk slot is outside the boot partition")
    kernel = boot[page:page + kernel_size]
    ramdisk = boot[ramdisk_offset:ramdisk_offset + ramdisk_size]
    digest = hashlib.sha1()
    for part in (kernel, ramdisk, b""):
        digest.update(part)
        digest.update(struct.pack("<I", len(part)))
    if boot[576:596] != digest.digest() or boot[596:608] != bytes(12):
        fail("boot image ID does not match its contents")
    if ramdisk[:2] != b"\x1f\x8b":
        fail("ramdisk is not gzip")
    return kernel, ramdisk_offset, pad(ramdisk_size), gzip.decompress(ramdisk)


def cpio_records(cpio):
    """newc records as (name, header, name_and_padding, data)."""
    offset, records = 0, []
    while True:
        header = cpio[offset:offset + 110]
        if header[:6] != b"070701":
            fail(f"bad cpio header at {offset}")
        file_size, name_size = int(header[54:62], 16), int(header[94:102], 16)
        name = cpio[offset + 110:offset + 110 + name_size - 1]
        data_offset = (offset + 110 + name_size + 3) & ~3
        records.append((name, header, cpio[offset + 110:data_offset],
                        cpio[data_offset:data_offset + file_size]))
        offset = (data_offset + file_size + 3) & ~3
        if name == b"TRAILER!!!":
            return records, cpio[offset:]


def patch_cpio(cpio):
    records, tail = cpio_records(cpio)
    out, changed = bytearray(), 0
    for name, header, name_part, data in records:
        if name == b"init.sun8i.usb.rc":
            if data.count(OLD_ACTION) != 1:
                fail("the stock mass_storage action was not found exactly once")
            data = data.replace(OLD_ACTION, NEW_ACTION)
            header = header[:54] + b"%08X" % len(data) + header[62:]
            changed += 1
        record = header + name_part
        out += record + data + bytes(-(len(record) + len(data)) % 4)
    if changed != 1:
        fail("init.sun8i.usb.rc not found")
    return bytes(out + tail)


def build(boot):
    kernel, ramdisk_offset, slot, cpio = parse_boot(boot)
    new_cpio = patch_cpio(cpio)
    ramdisk = min((gzip.compress(new_cpio, compresslevel=level, mtime=0) for level in range(1, 10)), key=len)
    if len(ramdisk) > slot:
        fail(f"patched ramdisk ({len(ramdisk)}) does not fit the original slot ({slot})")
    digest = hashlib.sha1()
    for part in (kernel, ramdisk, b""):
        digest.update(part)
        digest.update(struct.pack("<I", len(part)))
    new = bytearray(boot)
    struct.pack_into("<I", new, 16, len(ramdisk))
    new[576:608] = digest.digest() + bytes(12)
    new[ramdisk_offset:ramdisk_offset + slot] = ramdisk + bytes(slot - len(ramdisk))
    return bytes(new), ramdisk_offset, slot


def verify(old, new, ramdisk_offset, slot):
    """Independent re-parse: one rc file changed, nothing outside header + slot."""
    if len(old) != len(new):
        fail("boot partition length changed")
    _, _, _, old_cpio = parse_boot(old)
    _, _, _, new_cpio = parse_boot(new)
    old_records, _ = cpio_records(old_cpio)
    new_records, _ = cpio_records(new_cpio)
    if [r[0] for r in old_records] != [r[0] for r in new_records]:
        fail("cpio file list or order changed")
    changed = [o[0] for o, n in zip(old_records, new_records) if o[1:] != n[1:]]
    if changed != [b"init.sun8i.usb.rc"]:
        fail(f"unexpected cpio changes: {changed}")
    header_diffs = [i for i in range(ramdisk_offset) if old[i] != new[i]]
    if not header_diffs or not all(16 <= i < 20 or 576 <= i < 596 for i in header_diffs):
        fail("header changed outside the ramdisk size and image ID")
    if old[ramdisk_offset + slot:] != new[ramdisk_offset + slot:]:
        fail("bytes after the ramdisk slot changed")
    # The image ID ends at byte 595: the header write must cover two sectors, not one.
    return (header_diffs[-1] // SECTOR) + 1


def script_image(text):
    """Legacy U-Boot script image, as `mkimage -A arm -T script -C none` makes it."""
    body = struct.pack(">II", len(text), 0) + text
    header = bytearray(struct.pack(">IIIIIIIBBBB32s", 0x27051956, 0, int(time.time()), len(body),
                                   0, 0, zlib.crc32(body), 5, 2, 6, 0, b""))
    struct.pack_into(">I", header, 4, zlib.crc32(header))
    return bytes(header) + body


def guarded_script(title, expect, write, *, header_sector, header_sectors,
                   ramdisk_sector, ramdisk_sectors, crc, allow_partial=False):
    """Fail closed on selection, reads, payloads, source bytes and both readbacks.

    Restore may accept a mixture of exact original/patched ranges, as an
    interrupted forward write can leave the ramdisk new and the header original.
    Unknown/torn bytes never qualify. This is not an atomic write or repair for
    torn sectors: retain the backup and verify the whole eMMC before Android.
    """
    if expect not in ("orig", "new") or write not in ("orig", "new") or expect == write:
        fail("invalid boot patch direction")
    numbers = (header_sector, header_sectors, ramdisk_sector, ramdisk_sectors)
    if any(type(value) is not int or value <= 0 for value in numbers):
        fail("invalid boot patch range")
    if header_sectors * SECTOR > 0x1000000 or ramdisk_sectors * SECTOR > 0x1000000:
        fail("boot patch payload exceeds its reserved RAM slot")
    if header_sector + header_sectors > ramdisk_sector:
        fail("boot patch ranges overlap or are out of order")
    parts = (("header", header_sector, header_sectors),
             ("ramdisk", ramdisk_sector, ramdisk_sectors))
    for kind in ("orig", "new"):
        for part, _, _ in parts:
            value = crc.get(f"{kind}_{part}")
            if not isinstance(value, str) or len(value) != 8 or any(c not in "0123456789abcdef" for c in value):
                fail("invalid boot payload CRC")

    def payload_checks():
        return " && ".join(
            f"crc32 -v {ADDR[f'{kind}_{part}']:#x} {sectors * SECTOR:#x} {crc[f'{kind}_{part}']}"
            for kind in ("orig", "new") for part, _, sectors in parts)

    def read(part, sector, sectors):
        return f"mmc read {ADDR[f'read_{part}']:#x} {sector:#x} {sectors:#x}"

    def compare(kind, part, sectors):
        return f"cmp.b {ADDR[f'{kind}_{part}']:#x} {ADDR[f'read_{part}']:#x} {sectors * SECTOR:#x}"

    lines = [f"# {title}. Load all four original/new payloads with sunxi-fel first.",
             "# Every source range is checked before the first write. Header is committed last.",
             "# Failed select/read/CRC/compare stops the write path, even if scratch RAM is stale.",
             "if mmc dev 1 0; then",
             f"  if {payload_checks()} && " + " && ".join(read(*part) for part in parts) + "; then",
             "    setenv boot_source_ok 1"]
    for part, _, sectors in parts:
        lines.append(f"    if {compare(expect, part, sectors)}; then echo {part} holds expected source")
        if allow_partial:
            lines.append(f"    elif {compare(write, part, sectors)}; then echo {part} is already restored")
        lines.append(f"    else echo {part} source FAILED; setenv boot_source_ok 0; fi")
    lines += ['    if test "${boot_source_ok}" = 1; then',
              "      setenv boot_range_ok 1"]
    for part, sector, sectors in reversed(parts):
        lines += ['      if test "${boot_range_ok}" = 1; then',
                  "        setenv boot_range_ok 0",
                  f"        if {read(part, sector, sectors)} && {payload_checks()}; then"]
        if allow_partial:
            lines += [f"          if {compare(write, part, sectors)}; then",
                      f"            echo {part} already restored; setenv boot_range_ok 1",
                      f"          elif {compare(expect, part, sectors)}; then"]
        else:
            lines.append(f"          if {compare(expect, part, sectors)}; then")
        lines += [f"            if mmc write {ADDR[f'{write}_{part}']:#x} {sector:#x} {sectors:#x} && "
                  f"{read(part, sector, sectors)} && {compare(write, part, sectors)}; then",
                  f"              echo {part} written and read back; setenv boot_range_ok 1",
                  f"            else echo {part} write or readback FAILED; fi",
                  f"          else echo {part} source changed: nothing further written; fi",
                  f"        else echo {part} read or payload CRC FAILED; fi",
                  "      fi"]
    lines += ['      if test "${boot_range_ok}" = 1; then echo boot patch complete and read back; fi',
              "    else echo source bytes FAILED: nothing written; fi",
              "  else echo preflight read or payload CRC FAILED: nothing written; fi",
              "else echo eMMC select FAILED: nothing written; fi",
              "ums 0 mmc 1"]
    return "\n".join(lines) + "\n"


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    image_path, boot_sector = Path(sys.argv[1]), int(sys.argv[2])
    with open(image_path, "rb") as image:
        sizes = {start: count for start, count in partitions(image)}
        if boot_sector not in sizes:
            fail("that sector is not the start of a partition in this image")
        image.seek(boot_sector * SECTOR)
        old = image.read(sizes[boot_sector] * SECTOR)
        if len(old) != sizes[boot_sector] * SECTOR:
            fail("boot partition extends beyond the backup image")

    new, ramdisk_offset, slot = build(old)
    header_sectors = verify(old, new, ramdisk_offset, slot)
    header_bytes = header_sectors * SECTOR
    if old[header_bytes:ramdisk_offset] != new[header_bytes:ramdisk_offset]:
        fail("bytes between the header write and the ramdisk slot changed")

    if OUT.exists():
        fail(f"{OUT} already exists; preserve its plan and payloads before preparing another")
    OUT.mkdir(parents=True)
    payloads = {
        "orig_header": old[:header_bytes], "new_header": new[:header_bytes],
        "orig_ramdisk": old[ramdisk_offset:ramdisk_offset + slot],
        "new_ramdisk": new[ramdisk_offset:ramdisk_offset + slot],
    }
    for name, data in payloads.items():
        (OUT / f"{name.replace('_', '-')}.bin").write_bytes(data)
    crc = {name: f"{zlib.crc32(data):08x}" for name, data in payloads.items()}

    header_sector, ramdisk_sector = boot_sector, boot_sector + ramdisk_offset // SECTOR
    ramdisk_sectors = slot // SECTOR

    for name, title, expect, write in (("write-boot", "PF1007L boot patch", "orig", "new"),
                                       ("restore-boot", "Undo the PF1007L boot patch", "new", "orig")):
        script = guarded_script(title, expect, write, header_sector=header_sector,
                                header_sectors=header_sectors, ramdisk_sector=ramdisk_sector,
                                ramdisk_sectors=ramdisk_sectors, crc=crc,
                                allow_partial=name == "restore-boot")
        (OUT / f"{name}.cmd").write_text(script)
        (OUT / f"{name}.scr").write_bytes(script_image(script.encode()))
    plan = {
        "writes": [
            {"sector": ramdisk_sector, "sectors": ramdisk_sectors, "file": "new-ramdisk.bin"},
            {"sector": header_sector, "sectors": header_sectors, "file": "new-header.bin"},
        ],
        "crc32": crc,
    }
    (OUT / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")

    print(f"Boot image at sector {boot_sector}: ramdisk slot {slot} bytes at +{ramdisk_offset}")
    print(f"Write ranges: ramdisk [{ramdisk_sector}, {ramdisk_sector + ramdisk_sectors}), "
          f"header [{header_sector}, {header_sector + header_sectors})")
    print("Checks passed: one cpio file changed; header changes limited to ramdisk size + ID.")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
