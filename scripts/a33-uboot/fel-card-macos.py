#!/usr/bin/env python3
"""macOS port of the FEL SD card steps in docs/allwinner-a33-pf1007l.md, section 2.

Usage (run from the repo root; raw-device actions require sudo):
  python3 -I scripts/a33-uboot/fel-card-macos.py check diskN <exact-bytes>
  sudo python3 -I scripts/a33-uboot/fel-card-macos.py backup  diskN <exact-bytes>
  sudo python3 -I scripts/a33-uboot/fel-card-macos.py write   diskN <exact-bytes>
  sudo python3 -I scripts/a33-uboot/fel-card-macos.py restore diskN <exact-bytes>

The size argument is the card's exact byte count from `diskutil info`. It guards
against a disk number that changed after an unplug/replug. Add --built-in-sd
to explicitly allow a removable card in a built-in Secure Digital reader;
this uses the physical-disk inventory and structured IORegistry metadata.
The check action reads device metadata only and does not require sudo.
"""

import argparse
import gzip
import hashlib
import os
import plistlib
import re
import stat
import struct
import subprocess
import sys
from pathlib import Path
from xml.parsers.expat import ExpatError

REPO = Path(__file__).resolve().parents[2]
STUB_PATH = REPO / "diagnostics/sunxi-tools/bin/fel-sdboot.sunxi"
STUB_SHA256 = "2ccec08a026840571f3804671ba72afae840db27112a43f2b1f122075bc808bc"
BACKUP_PATH = REPO / "backups/a33-fel-card-prefix.bin.gz"
PREFIX_SIZE = 4 * 1024 * 1024
STUB_OFFSET = 8192
STUB_SIZE = 8192
SECTOR_SIZE = 512
DISKUTIL = "/usr/sbin/diskutil"
IOREG = "/usr/sbin/ioreg"
METADATA_TIMEOUT = 10
UNMOUNT_TIMEOUT = 15
IDENTITY_KEYS = (
    "DeviceIdentifier", "MediaName", "TotalSize", "DeviceBlockSize", "Internal",
    "RemovableMedia", "Removable", "BusProtocol", "VirtualOrPhysical", "WholeDisk",
    "WritableMedia", "Content", "DeviceTreePath", "RegistryEntryID",
)


def fail(message):
    sys.exit(f"STOP: {message}")


def progress(message):
    print(message, flush=True)


def disk_info(identifier):
    try:
        output = subprocess.check_output(
            [DISKUTIL, "info", "-plist", identifier], timeout=METADATA_TIMEOUT,
            stderr=subprocess.PIPE,
        )
        info = plistlib.loads(output)
    except subprocess.TimeoutExpired:
        fail(f"diskutil metadata timed out for {identifier}; do not bypass the disk checks")
    except (subprocess.CalledProcessError, OSError, ValueError, plistlib.InvalidFileException):
        fail(f"could not read diskutil metadata for {identifier}")
    if not isinstance(info, dict):
        fail(f"invalid diskutil metadata for {identifier}")
    return info


def metadata_plist(command, label):
    try:
        output = subprocess.check_output(command, timeout=METADATA_TIMEOUT, stderr=subprocess.PIPE)
        return plistlib.loads(output)
    except subprocess.TimeoutExpired:
        fail(f"{label} metadata timed out; do not bypass the disk checks")
    except (subprocess.CalledProcessError, OSError, ValueError,
            plistlib.InvalidFileException, ExpatError):
        fail(f"could not read {label} metadata")


def registry_card_info(identifier, inventory, device_roots):
    """Require agreement between the physical inventory and the card's transport tree."""
    disks = inventory.get("AllDisksAndPartitions") if isinstance(inventory, dict) else None
    if not isinstance(disks, list) or any(not isinstance(disk, dict) for disk in disks):
        fail("invalid physical-disk inventory")
    listed = [disk for disk in disks if disk.get("DeviceIdentifier") == identifier]
    if len(listed) != 1:
        fail("card is not uniquely present as a whole disk in the physical inventory")
    listed = listed[0]
    if (listed.get("VirtualOrPhysical", "Physical") != "Physical" or
            listed.get("WholeDisk", True) is not True):
        fail("physical inventory does not identify a physical whole disk")
    if not isinstance(device_roots, list) or not device_roots:
        fail("no IOBlockStorageDevice transport trees returned")

    matches = []

    def walk(node, ancestors):
        if not isinstance(node, dict):
            fail("invalid IORegistry transport tree")
        children = node.get("IORegistryEntryChildren", [])
        if not isinstance(children, list):
            fail("invalid IORegistry transport children")
        if node.get("IOObjectClass") == "IOMedia" and node.get("BSD Name") == identifier:
            matches.append((node, ancestors))
        for child in children:
            walk(child, ancestors + [node])

    for root in device_roots:
        walk(root, [])
    if len(matches) != 1:
        fail("card has no unique IOMedia in the transport trees")
    media, ancestors = matches[0]
    # The supported built-in reader publishes device -> driver -> whole media.
    # Never accept a nested media/filter representation of the same BSD disk.
    if (len(ancestors) != 2 or
            ancestors[1].get("IOObjectClass") != "IOBlockStorageDriver"):
        fail("expected a direct whole-card IOMedia under an IOBlockStorageDriver")
    device = ancestors[0]
    protocol = device.get("Protocol Characteristics")
    if not isinstance(protocol, dict):
        fail("card's transport has no protocol metadata")
    if (protocol.get("Physical Interconnect") != "Secure Digital" or
            protocol.get("Physical Interconnect Location") != "Internal"):
        fail("card's transport is not an internal Secure Digital reader")

    # Apple's Disk Arbitration uses these same IOMedia and transport properties:
    # https://github.com/apple-oss-distributions/DiskArbitration/blob/main/diskarbitrationd/DADisk.c
    # Secure Digital/Internal definitions:
    # https://github.com/apple-oss-distributions/IOStorageFamily/blob/main/IOStorageProtocolCharacteristics.h
    required = ("Whole", "Removable", "Writable", "Size", "Preferred Block Size",
                "Content", "IORegistryEntryName", "IORegistryEntryID")
    if any(key not in media for key in required):
        fail("incomplete whole-card IOMedia metadata")
    if any(type(media[key]) is not bool for key in ("Whole", "Removable", "Writable")):
        fail("invalid whole-card IOMedia flags")
    if any(type(media[key]) is not int or media[key] <= 0
           for key in ("Size", "Preferred Block Size", "IORegistryEntryID")):
        fail("invalid whole-card IOMedia size, block size or registry identity")
    if (type(listed.get("Size")) is not int or listed["Size"] != media["Size"] or
            listed.get("Content") != media["Content"]):
        fail("physical inventory and IOMedia size or content disagree")
    names = [node.get("IORegistryEntryName") for node in ancestors + [media]]
    if any(not isinstance(name, str) or not name for name in names):
        fail("incomplete IORegistry transport path")
    return {
        "DeviceIdentifier": media["BSD Name"], "WholeDisk": media["Whole"],
        "VirtualOrPhysical": "Physical", "RemovableMedia": media["Removable"],
        "WritableMedia": media["Writable"], "DeviceBlockSize": media["Preferred Block Size"],
        "TotalSize": media["Size"], "MediaName": media["IORegistryEntryName"],
        "Internal": True, "BusProtocol": protocol["Physical Interconnect"],
        "Content": media["Content"], "DeviceTreePath": "IOService:" + "/".join(names),
        "RegistryEntryID": media["IORegistryEntryID"],
    }


def built_in_sd_info(identifier):
    inventory = metadata_plist([DISKUTIL, "list", "-plist", "physical"], "physical-disk inventory")
    # ioreg -c matches subclasses; -r retains their complete transport subtrees.
    trees = metadata_plist(
        [IOREG, "-a", "-l", "-r", "-c", "IOBlockStorageDevice", "-p", "IOService"],
        "built-in SD transport",
    )
    return registry_card_info(identifier, inventory, trees)


def boot_disks(root_info):
    """Resolve the running macOS volume to physical whole disks, or stop."""
    stores = root_info.get("APFSPhysicalStores")
    if stores is not None:
        if not isinstance(stores, list) or not stores:
            fail("cannot resolve the boot volume's APFS physical stores")
        disks = set()
        for store in stores:
            identifier = store.get("APFSPhysicalStore") if isinstance(store, dict) else None
            match = re.fullmatch(r"(disk[0-9]+)(?:s[0-9]+)*", identifier) if isinstance(identifier, str) else None
            if not match:
                fail("cannot resolve the boot volume's APFS physical stores")
            disks.add(match.group(1))
        return disks
    if root_info.get("APFSContainerReference") or root_info.get("FilesystemType") == "apfs":
        fail("boot volume has no APFS physical-store metadata; refusing to guess")
    if root_info.get("VirtualOrPhysical") != "Physical":
        fail("cannot resolve the boot volume to a physical disk")
    identifier = (
        root_info.get("DeviceIdentifier") if root_info.get("WholeDisk") is True
        else root_info.get("PartOfWhole") or root_info.get("ParentWholeDisk")
    )
    if not isinstance(identifier, str) or not re.fullmatch(r"disk[0-9]+", identifier):
        fail("cannot resolve the boot volume to a physical whole disk")
    return {identifier}


def validate_card_info(identifier, expected_size, info, built_in_sd=False):
    if info.get("DeviceIdentifier") != identifier or info.get("WholeDisk") is not True:
        fail("not the requested whole disk")
    if info.get("VirtualOrPhysical") != "Physical":
        fail("disk is not physical media")
    if info.get("RemovableMedia") is not True and info.get("Removable") is not True:
        fail("disk is not removable media")
    if info.get("WritableMedia") is not True:
        fail("card is not writable; check the SD adapter's lock switch")
    if info.get("DeviceBlockSize") != SECTOR_SIZE:
        fail("expected 512-byte card sectors")
    if info.get("TotalSize") != expected_size:
        fail(f"size {info.get('TotalSize')} != expected {expected_size}")
    media_name = info.get("MediaName")
    if not isinstance(media_name, str) or not media_name:
        fail("card has no valid media-name metadata")
    if re.match(r"UMS disk\b", media_name, re.I):
        fail("disk is the frame's U-Boot UMS device, not a card")
    external_usb = info.get("Internal") is False and info.get("BusProtocol") == "USB"
    internal_sd = info.get("Internal") is True and info.get("BusProtocol") == "Secure Digital"
    if internal_sd and not built_in_sd:
        fail("built-in Secure Digital reader requires --built-in-sd")
    if not external_usb and not (built_in_sd and internal_sd):
        fail("expected an external USB reader or an explicitly allowed built-in Secure Digital reader")
    if info.get("Content") != "FDisk_partition_scheme":
        fail("expected an MBR card; formatting requires separate approval")


def inspect_card(identifier, expected_size, built_in_sd):
    info = built_in_sd_info(identifier) if built_in_sd else disk_info(identifier)
    validate_card_info(identifier, expected_size, info, built_in_sd)
    if identifier in boot_disks(disk_info("/")):
        fail("disk backs the running macOS boot volume")
    return info


def check_card(identifier, expected_size, built_in_sd=False, unmount=True):
    if not re.fullmatch(r"disk[0-9]+", identifier):
        fail("pass a whole disk like disk4, not a partition")
    if expected_size < PREFIX_SIZE or expected_size % SECTOR_SIZE:
        fail("expected a positive exact card size of at least 4 MiB, in whole sectors")

    progress(f"Checking {identifier} metadata...")
    before = inspect_card(identifier, expected_size, built_in_sd)
    progress(f"Card metadata verified: {identifier}, {expected_size} bytes.")
    raw_path = f"/dev/r{identifier}"
    if not unmount:
        return raw_path

    try:
        progress(f"Unmounting {identifier}...")
        subprocess.run(
            [DISKUTIL, "unmountDisk", identifier], check=True, timeout=UNMOUNT_TIMEOUT,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        progress(f"Rechecking {identifier} identity after unmount...")
        after = inspect_card(identifier, expected_size, built_in_sd)
        if any(before.get(key) != after.get(key) for key in IDENTITY_KEYS):
            fail("disk identity changed while unmounting; identify the card again")
        progress("Card identity rechecked; checking for remaining mounts...")
        mounts = subprocess.check_output(["/sbin/mount"], text=True, timeout=METADATA_TIMEOUT)
    except subprocess.TimeoutExpired:
        fail("unmount or mount inspection timed out; do not open the raw disk")
    except (subprocess.CalledProcessError, OSError):
        fail("card could not be unmounted and verified; close its Finder windows and retry")
    for line in mounts.splitlines():
        if line.startswith(f"/dev/{identifier}s") or line.startswith(f"/dev/{identifier} "):
            fail(f"still mounted: {line}")

    progress("Card unmounted and identity verified.")
    return raw_path


def close_raw_device(fd):
    progress("Closing raw card device...")
    os.close(fd)
    progress("Raw card device closed.")


def open_raw_device(raw_path, flags):
    if not re.fullmatch(r"/dev/rdisk[0-9]+", raw_path):
        fail("expected a raw whole-disk device")
    fd = None
    try:
        if not stat.S_ISCHR(os.lstat(raw_path).st_mode):
            fail("raw disk path is not a character device")
        mode = "read/write" if flags & (os.O_RDWR | os.O_WRONLY) else "read-only"
        progress(f"Opening raw card {mode}: {raw_path}...")
        fd = os.open(raw_path, flags | os.O_NOFOLLOW)
        progress("Raw card device opened.")
        if not stat.S_ISCHR(os.fstat(fd).st_mode):
            close_raw_device(fd)
            fail("opened disk is not a character device")
    except OSError:
        if fd is not None:
            close_raw_device(fd)
        fail("cannot open the raw card device")
    return fd


def read_prefix_fd(fd):
    progress(f"Reading prefix pass 1/2: {PREFIX_SIZE} bytes at offset 0...")
    first = os.pread(fd, PREFIX_SIZE, 0)
    progress(f"Prefix pass 1/2 returned {len(first)} bytes.")
    progress(f"Reading prefix pass 2/2: {PREFIX_SIZE} bytes at offset 0...")
    second = os.pread(fd, PREFIX_SIZE, 0)
    progress(f"Prefix pass 2/2 returned {len(second)} bytes.")
    if len(first) != PREFIX_SIZE:
        fail(f"short read: {len(first)} bytes")
    if first != second:
        fail("independent re-read differs")
    return first


def read_prefix(raw_path):
    fd = open_raw_device(raw_path, os.O_RDONLY)
    try:
        return read_prefix_fd(fd)
    finally:
        close_raw_device(fd)


def check_layout(prefix):
    if prefix[510:512] != b"\x55\xaa":
        fail("expected an MBR signature")
    entries = [prefix[446 + i * 16 : 462 + i * 16] for i in range(4)]
    active = [entry for entry in entries if entry[4]]
    if not active or any(entry[4] == 0xEE for entry in active):
        fail("GPT or empty layout not supported")
    for entry in active:
        start = struct.unpack_from("<I", entry, 8)[0]
        if start < 8192:
            fail(f"partition starts at sector {start}, too close to the stub")
        print(f"  partition type {entry[4]:#04x} starts at sector {start}")


def load_stub():
    stub = STUB_PATH.read_bytes()
    if len(stub) != STUB_SIZE or stub[4:12] != b"eGON.BT0":
        fail("stub has the wrong size or magic")
    if hashlib.sha256(stub).hexdigest() != STUB_SHA256:
        fail("stub SHA-256 mismatch")
    return stub


def backup(raw_path):
    progress("Backing up the card prefix; card access is read-only.")
    prefix = read_prefix(raw_path)
    check_layout(prefix)
    BACKUP_PATH.parent.mkdir(exist_ok=True)
    os.umask(0o077)
    progress(f"Saving card prefix backup to {BACKUP_PATH}...")
    with gzip.open(BACKUP_PATH, "xb") as handle:
        handle.write(prefix)
    progress("Verifying saved prefix backup...")
    if gzip.decompress(BACKUP_PATH.read_bytes()) != prefix:
        fail("backup readback mismatch")
    progress(f"Saved prefix backup verified: {len(prefix)} bytes.")
    print("Card prefix backed up:", BACKUP_PATH)
    print("SHA-256:", hashlib.sha256(prefix).hexdigest())


def load_backup():
    before = gzip.decompress(BACKUP_PATH.read_bytes())
    if len(before) != PREFIX_SIZE:
        fail("backup has the wrong length")
    return before


def write_region(raw_path, data, expected_prefix, acceptable_prefixes):
    if len(data) != STUB_SIZE or len(expected_prefix) != PREFIX_SIZE:
        fail("write does not match the fixed stub region")
    if expected_prefix[STUB_OFFSET:STUB_OFFSET + STUB_SIZE] != data:
        fail("write data differs from the expected prefix")
    fd = open_raw_device(raw_path, os.O_RDWR)
    try:
        if read_prefix_fd(fd) not in acceptable_prefixes:
            fail("card changed before the write; keep the backup")
        written = os.pwrite(fd, data, STUB_OFFSET)
        os.fsync(fd)
    finally:
        close_raw_device(fd)
    if written != len(data):
        fail(f"short write: {written} bytes")
    if read_prefix(raw_path) != expected_prefix:
        fail("card readback mismatch")


def write(raw_path):
    stub = load_stub()
    before = load_backup()
    if read_prefix(raw_path) != before:
        fail("card no longer matches the backup; was it swapped?")
    check_layout(before)
    expected = before[:STUB_OFFSET] + stub + before[STUB_OFFSET + STUB_SIZE :]
    write_region(raw_path, stub, expected, (before,))
    print("Wrote 8192 bytes at byte offset 8192. Readback verified.")


def restore(raw_path):
    stub = load_stub()
    before = load_backup()
    current = read_prefix(raw_path)
    expected_written = before[:STUB_OFFSET] + stub + before[STUB_OFFSET + STUB_SIZE :]
    if current not in (before, expected_written):
        fail("card matches neither the backup nor the stubbed state")
    write_region(raw_path, before[STUB_OFFSET : STUB_OFFSET + STUB_SIZE], before,
                 (before, expected_written))
    print("Original bytes restored. Readback verified.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--built-in-sd", action="store_true",
                        help="explicitly allow a removable card in a built-in Secure Digital reader")
    parser.add_argument("action", choices=("check", "backup", "write", "restore"))
    parser.add_argument("identifier", help="whole disk identifier from diskutil, such as disk4")
    parser.add_argument("exact_bytes", type=int, help="exact byte count from diskutil info")
    args = parser.parse_args()
    if args.action != "check" and os.geteuid() != 0:
        fail("run with sudo")
    raw_path = check_card(args.identifier, args.exact_bytes, args.built_in_sd,
                          unmount=args.action != "check")
    if args.action == "check":
        print(f"Metadata checks passed for {args.identifier}: {args.exact_bytes} bytes.")
        print("No raw card bytes read or changed. Backup still validates the on-card layout.")
        return
    {"backup": backup, "write": write, "restore": restore}[args.action](raw_path)


if __name__ == "__main__":
    main()
