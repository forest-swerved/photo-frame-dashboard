"""Safety regression tests; every device and diskutil interaction is mocked.

Run: python3 -I -m unittest discover -s scripts/a33-uboot -p test_fel_card_macos.py
"""

import contextlib
import copy
import gzip
import importlib.util
import io
import os
from pathlib import Path
import plistlib
import stat
import struct
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "fel_card_macos", Path(__file__).with_name("fel-card-macos.py")
)
CARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CARD)
SIZE = 31_268_536_320
RAW = "/dev/rdisk6"


def card_info(**changes):
    info = {
        "DeviceIdentifier": "disk6", "WholeDisk": True,
        "VirtualOrPhysical": "Physical", "RemovableMedia": True,
        "WritableMedia": True, "DeviceBlockSize": 512, "TotalSize": SIZE,
        "MediaName": "Apple SDXC Reader Media", "Internal": True,
        "BusProtocol": "Secure Digital", "Content": "FDisk_partition_scheme",
        "DeviceTreePath": "mock/card/reader",
    }
    info.update(changes)
    return info


def root_info():
    return {
        "DeviceIdentifier": "disk3s1s1", "APFSContainerReference": "disk3",
        "APFSPhysicalStores": [{"APFSPhysicalStore": "disk0s2"}],
        "VirtualOrPhysical": "Virtual", "WholeDisk": False,
    }


def physical_inventory():
    return {"AllDisksAndPartitions": [{
        "DeviceIdentifier": "disk6", "Size": SIZE, "Content": "FDisk_partition_scheme",
        "Partitions": [{"DeviceIdentifier": "disk6s1", "Content": "DOS_FAT_32"}],
    }]}


def transport_trees():
    return [{
        "IOObjectClass": "AppleSDXCBlockStorageDevice",
        "IORegistryEntryName": "AppleSDXCBlockStorageDevice",
        "Protocol Characteristics": {
            "Physical Interconnect": "Secure Digital",
            "Physical Interconnect Location": "Internal",
        },
        "IORegistryEntryChildren": [{
            "IOObjectClass": "IOBlockStorageDriver", "IORegistryEntryName": "IOBlockStorageDriver",
            "IORegistryEntryChildren": [{
                "IOObjectClass": "IOMedia", "IORegistryEntryName": "Apple SDXC Reader Media",
                "BSD Name": "disk6", "Whole": True, "Removable": True, "Writable": True,
                "Size": SIZE, "Preferred Block Size": 512, "Content": "FDisk_partition_scheme",
                "IORegistryEntryID": 4295553358,
                "IORegistryEntryChildren": [{
                    "IOObjectClass": "IOFDiskPartitionScheme", "IORegistryEntryName": "IOFDiskPartitionScheme",
                    "IORegistryEntryChildren": [{
                        "IOObjectClass": "IOMedia", "IORegistryEntryName": "CARD",
                        "BSD Name": "disk6s1", "Whole": False,
                    }],
                }],
            }],
        }],
    }]


def whole_media(trees):
    return trees[0]["IORegistryEntryChildren"][0]["IORegistryEntryChildren"][0]


def prefix(start=8192, partition_type=0x0C):
    data = bytearray(CARD.PREFIX_SIZE)
    data[510:512] = b"\x55\xaa"
    data[450] = partition_type
    struct.pack_into("<I", data, 454, start)
    return bytes(data)


class QuietProgressTestCase(unittest.TestCase):
    def setUp(self):
        progress = patch.object(CARD, "progress")
        progress.start()
        self.addCleanup(progress.stop)


class MetadataGuards(QuietProgressTestCase):
    def test_built_in_reader_requires_explicit_flag(self):
        with self.assertRaisesRegex(SystemExit, "requires --built-in-sd"):
            CARD.validate_card_info("disk6", SIZE, card_info())
        CARD.validate_card_info("disk6", SIZE, card_info(), built_in_sd=True)

    def test_external_usb_still_works_without_flag(self):
        CARD.validate_card_info("disk6", SIZE, card_info(Internal=False, BusProtocol="USB"))

    def test_unsafe_metadata_rejected_before_unmount_or_open(self):
        changes = (
            {"DeviceIdentifier": "disk5"}, {"WholeDisk": False},
            {"VirtualOrPhysical": "Virtual"}, {"VirtualOrPhysical": None},
            {"RemovableMedia": False}, {"RemovableMedia": None},
            {"WritableMedia": False}, {"WritableMedia": None},
            {"DeviceBlockSize": 4096}, {"DeviceBlockSize": None},
            {"TotalSize": SIZE - 512}, {"MediaName": "UMS disk 1"},
            {"MediaName": "UMS disk 1 Media"},
            {"MediaName": None},
            {"BusProtocol": "Apple Fabric"}, {"BusProtocol": None},
            {"Internal": None}, {"Content": "GUID_partition_scheme"},
            {"Content": None},
        )
        for change in changes:
            with self.subTest(change=change), \
                    patch.object(CARD, "built_in_sd_info", return_value=card_info(**change)), \
                    patch.object(CARD, "disk_info", return_value=root_info()), \
                    patch.object(CARD.subprocess, "run") as unmount, \
                    patch.object(CARD.os, "open") as raw_open:
                with self.assertRaises(SystemExit):
                    CARD.check_card("disk6", SIZE, built_in_sd=True)
                unmount.assert_not_called()
                raw_open.assert_not_called()

    def test_malformed_identifier_or_size_never_reaches_diskutil(self):
        for identifier, size in (("disk6s1", SIZE), ("disk../file", SIZE),
                                 ("disk", SIZE), ("disk6", -512),
                                 ("disk6", SIZE + 1)):
            with self.subTest(identifier=identifier, size=size), \
                    patch.object(CARD, "disk_info") as metadata:
                with self.assertRaises(SystemExit):
                    CARD.check_card(identifier, size, built_in_sd=True)
                metadata.assert_not_called()

    def test_apfs_boot_stores_are_resolved(self):
        info = root_info()
        info["APFSPhysicalStores"].append({"APFSPhysicalStore": "disk2s2"})
        self.assertEqual(CARD.boot_disks(info), {"disk0", "disk2"})

    def test_direct_root_whole_disk_and_partition_are_resolved(self):
        self.assertEqual(CARD.boot_disks({
            "VirtualOrPhysical": "Physical", "WholeDisk": True,
            "DeviceIdentifier": "disk6",
        }), {"disk6"})
        for key in ("PartOfWhole", "ParentWholeDisk"):
            self.assertEqual(CARD.boot_disks({
                "VirtualOrPhysical": "Physical", "WholeDisk": False, key: "disk6",
            }), {"disk6"})

    def test_boot_card_is_rejected_before_unmount(self):
        roots = (
            dict(root_info(), APFSPhysicalStores=[{"APFSPhysicalStore": "disk6s1"}]),
            {"VirtualOrPhysical": "Physical", "WholeDisk": False, "PartOfWhole": "disk6"},
        )
        for root in roots:
            with self.subTest(root=root), \
                    patch.object(CARD, "built_in_sd_info", return_value=card_info()), \
                    patch.object(CARD, "disk_info", return_value=root), \
                    patch.object(CARD.subprocess, "run") as unmount:
                with self.assertRaisesRegex(SystemExit, "backs the running macOS"):
                    CARD.check_card("disk6", SIZE, built_in_sd=True)
                unmount.assert_not_called()

    def test_unknown_boot_relationship_fails_closed(self):
        unknown_roots = (
            {}, dict(root_info(), APFSPhysicalStores=[]),
            dict(root_info(), APFSPhysicalStores=[{}]),
            dict(root_info(), APFSPhysicalStores=[{"APFSPhysicalStore": 6}]),
            {"APFSContainerReference": "disk3", "PartOfWhole": "disk3"},
            {"VirtualOrPhysical": "Virtual", "PartOfWhole": "disk3"},
        )
        for root in unknown_roots:
            with self.subTest(root=root), \
                    patch.object(CARD, "built_in_sd_info", return_value=card_info()), \
                    patch.object(CARD, "disk_info", return_value=root), \
                    patch.object(CARD.subprocess, "run") as unmount:
                with self.assertRaises(SystemExit):
                    CARD.check_card("disk6", SIZE, built_in_sd=True)
                unmount.assert_not_called()

    def test_check_action_needs_no_root_unmount_or_raw_access(self):
        argv = ["fel-card-macos.py", "--built-in-sd", "check", "disk6", str(SIZE)]
        with patch.object(CARD.sys, "argv", argv), \
                patch.object(CARD, "built_in_sd_info", return_value=card_info()), \
                patch.object(CARD, "disk_info", return_value=root_info()), \
                patch.object(CARD.os, "geteuid", return_value=501), \
                patch.object(CARD.subprocess, "run") as unmount, \
                patch.object(CARD.os, "open") as raw_open, \
                contextlib.redirect_stdout(io.StringIO()):
            CARD.main()
            unmount.assert_not_called()
            raw_open.assert_not_called()

    def test_diskutil_metadata_has_absolute_path_and_timeout(self):
        with patch.object(CARD.subprocess, "check_output", return_value=plistlib.dumps(card_info())) as call:
            self.assertEqual(CARD.disk_info("disk6"), card_info())
            call.assert_called_once_with(
                ["/usr/sbin/diskutil", "info", "-plist", "disk6"],
                timeout=CARD.METADATA_TIMEOUT, stderr=subprocess.PIPE,
            )

    def test_invalid_diskutil_response_fails_closed(self):
        for output in (b"not a plist", plistlib.dumps([])):
            with self.subTest(output=output), \
                    patch.object(CARD.subprocess, "check_output", return_value=output), \
                    patch.object(CARD.subprocess, "run") as unmount:
                with self.assertRaises(SystemExit):
                    CARD.check_card("disk6", SIZE, built_in_sd=True)
                unmount.assert_not_called()

    def test_original_positional_backup_command_remains_supported(self):
        argv = ["fel-card-macos.py", "backup", "disk6", str(SIZE)]
        with patch.object(CARD.sys, "argv", argv), \
                patch.object(CARD.os, "geteuid", return_value=0), \
                patch.object(CARD, "check_card", return_value=RAW) as check, \
                patch.object(CARD, "backup") as backup:
            CARD.main()
            check.assert_called_once_with("disk6", SIZE, False, unmount=True)
            backup.assert_called_once_with(RAW)

    def test_backup_write_and_restore_need_root_before_metadata(self):
        for action in ("backup", "write", "restore"):
            argv = ["fel-card-macos.py", "--built-in-sd", action, "disk6", str(SIZE)]
            with self.subTest(action=action), \
                    patch.object(CARD.sys, "argv", argv), \
                    patch.object(CARD.os, "geteuid", return_value=501), \
                    patch.object(CARD, "disk_info") as metadata:
                with self.assertRaisesRegex(SystemExit, "run with sudo"):
                    CARD.main()
                metadata.assert_not_called()

    def test_timed_out_diskutil_does_not_fall_back_to_guessed_metadata(self):
        with patch.object(CARD.subprocess, "check_output", side_effect=subprocess.TimeoutExpired("diskutil", 10)), \
                patch.object(CARD.subprocess, "run") as unmount:
            with self.assertRaisesRegex(SystemExit, "metadata timed out"):
                CARD.check_card("disk6", SIZE, built_in_sd=True)
            unmount.assert_not_called()

    def test_unmount_rechecks_identity_and_remaining_mounts(self):
        for after, mounts, message in (
            (card_info(MediaName="Different card"), "", "identity changed"),
            (card_info(), "/dev/disk6s1 on /Volumes/CARD (msdos)", "still mounted"),
        ):
            with self.subTest(message=message), \
                    patch.object(CARD, "built_in_sd_info", side_effect=[card_info(), after]), \
                    patch.object(CARD, "disk_info", return_value=root_info()), \
                    patch.object(CARD.subprocess, "run"), \
                    patch.object(CARD.subprocess, "check_output", return_value=mounts), \
                    patch.object(CARD.os, "open") as raw_open:
                with self.assertRaisesRegex(SystemExit, message):
                    CARD.check_card("disk6", SIZE, built_in_sd=True)
                raw_open.assert_not_called()

    def test_unmount_timeout_stops_before_raw_access(self):
        with patch.object(CARD, "built_in_sd_info", return_value=card_info()), \
                patch.object(CARD, "disk_info", return_value=root_info()), \
                patch.object(CARD.subprocess, "run", side_effect=subprocess.TimeoutExpired("diskutil", 15)), \
                patch.object(CARD.os, "open") as raw_open:
            with self.assertRaisesRegex(SystemExit, "unmount or mount inspection timed out"):
                CARD.check_card("disk6", SIZE, built_in_sd=True)
            raw_open.assert_not_called()


class RegistryMetadataGuards(QuietProgressTestCase):
    def guarded_info(self, inventory, trees):
        info = CARD.registry_card_info("disk6", inventory, trees)
        CARD.validate_card_info("disk6", SIZE, info, built_in_sd=True)
        return info

    def test_structured_card_agreement_preserves_registry_identity(self):
        info = self.guarded_info(physical_inventory(), transport_trees())
        self.assertEqual(info["RegistryEntryID"], 4295553358)
        self.assertEqual(info["BusProtocol"], "Secure Digital")
        self.assertIs(info["Internal"], True)
        self.assertEqual(info["TotalSize"], SIZE)
        self.assertEqual(info["DeviceBlockSize"], 512)

    def test_missing_duplicate_or_conflicting_inventory_stops(self):
        inventories = [{}, {"AllDisksAndPartitions": []}, {"AllDisksAndPartitions": [None]}]
        duplicate = physical_inventory()
        duplicate["AllDisksAndPartitions"].append(copy.deepcopy(duplicate["AllDisksAndPartitions"][0]))
        inventories.append(duplicate)
        for change in ({"DeviceIdentifier": "disk5"}, {"Size": SIZE - 512},
                       {"Size": str(SIZE)}, {"Content": "GUID_partition_scheme"},
                       {"VirtualOrPhysical": "Virtual"}, {"WholeDisk": False}):
            inventory = physical_inventory()
            inventory["AllDisksAndPartitions"][0].update(change)
            inventories.append(inventory)
        for inventory in inventories:
            with self.subTest(inventory=inventory), self.assertRaises(SystemExit):
                self.guarded_info(inventory, transport_trees())

    def test_protocol_must_come_from_the_card_transport_ancestor(self):
        for protocol in (None, {}, {"Physical Interconnect": "USB", "Physical Interconnect Location": "Internal"},
                         {"Physical Interconnect": "Secure Digital", "Physical Interconnect Location": "External"}):
            trees = transport_trees()
            trees[0]["Protocol Characteristics"] = protocol
            # A descendant's SD label cannot supply its transport's missing/wrong protocol.
            whole_media(trees)["Protocol Characteristics"] = transport_trees()[0]["Protocol Characteristics"]
            with self.subTest(protocol=protocol), self.assertRaises(SystemExit):
                self.guarded_info(physical_inventory(), trees)

    def test_other_transport_cannot_supply_the_card_protocol(self):
        trees = transport_trees()
        trees[0]["Protocol Characteristics"] = {}
        unrelated = transport_trees()[0]
        unrelated["IORegistryEntryChildren"] = []
        trees.append(unrelated)
        with self.assertRaisesRegex(SystemExit, "transport is not an internal"):
            self.guarded_info(physical_inventory(), trees)

    def test_duplicate_or_missing_whole_media_stops(self):
        empty = transport_trees()
        whole_media(empty)["BSD Name"] = "disk5"
        duplicate_root = transport_trees() + transport_trees()
        duplicate_media = transport_trees()
        driver = duplicate_media[0]["IORegistryEntryChildren"][0]
        driver["IORegistryEntryChildren"].append(copy.deepcopy(whole_media(duplicate_media)))
        for trees in ([], empty, duplicate_root, duplicate_media):
            with self.subTest(root_count=len(trees)), self.assertRaises(SystemExit):
                self.guarded_info(physical_inventory(), trees)

    def test_nested_media_or_wrong_driver_stops(self):
        nested = transport_trees()
        driver = nested[0]["IORegistryEntryChildren"][0]
        driver["IORegistryEntryChildren"] = [{
            "IOObjectClass": "IOMedia", "IORegistryEntryName": "Outer virtual media",
            "BSD Name": "disk7", "IORegistryEntryChildren": driver["IORegistryEntryChildren"],
        }]
        wrong_driver = transport_trees()
        wrong_driver[0]["IORegistryEntryChildren"][0]["IOObjectClass"] = "VirtualStorageDriver"
        for trees in (nested, wrong_driver):
            with self.assertRaisesRegex(SystemExit, "direct whole-card IOMedia"):
                self.guarded_info(physical_inventory(), trees)

    def test_missing_whole_media_properties_stop(self):
        keys = ("Whole", "Removable", "Writable", "Size", "Preferred Block Size", "Content",
                "IORegistryEntryName", "IORegistryEntryID", "IOObjectClass", "BSD Name")
        for key in keys:
            trees = transport_trees()
            del whole_media(trees)[key]
            with self.subTest(missing=key), self.assertRaises(SystemExit):
                self.guarded_info(physical_inventory(), trees)

    def test_unsafe_media_values_stop(self):
        for change in ({"Whole": False}, {"Removable": False}, {"Writable": False},
                       {"Whole": "true"}, {"Size": str(SIZE)}, {"Preferred Block Size": 4096},
                       {"IORegistryEntryID": 0}, {"IORegistryEntryID": "4295553358"},
                       {"IORegistryEntryName": ""}):
            trees = transport_trees()
            whole_media(trees).update(change)
            with self.subTest(change=change), self.assertRaises(SystemExit):
                self.guarded_info(physical_inventory(), trees)

    def test_backend_commands_are_structured_absolute_and_bounded(self):
        outputs = [plistlib.dumps(physical_inventory()), plistlib.dumps(transport_trees())]
        with patch.object(CARD.subprocess, "check_output", side_effect=outputs) as call:
            info = CARD.built_in_sd_info("disk6")
            self.assertEqual(info["RegistryEntryID"], 4295553358)
            self.assertEqual(call.call_args_list[0].args[0],
                             ["/usr/sbin/diskutil", "list", "-plist", "physical"])
            self.assertEqual(call.call_args_list[1].args[0],
                             ["/usr/sbin/ioreg", "-a", "-l", "-r", "-c", "IOBlockStorageDevice", "-p", "IOService"])
            for invocation in call.call_args_list:
                self.assertEqual(invocation.kwargs["timeout"], CARD.METADATA_TIMEOUT)
                self.assertEqual(invocation.kwargs["stderr"], subprocess.PIPE)

    def test_timeout_or_invalid_transport_plist_stops_without_unmount(self):
        for response in (subprocess.TimeoutExpired("ioreg", 10), b"not a plist", plistlib.dumps({})):
            with self.subTest(response=type(response).__name__), \
                    patch.object(CARD.subprocess, "check_output", side_effect=[plistlib.dumps(physical_inventory()), response]), \
                    patch.object(CARD.subprocess, "run") as unmount, \
                    patch.object(CARD.os, "open") as raw_open:
                with self.assertRaises(SystemExit):
                    CARD.check_card("disk6", SIZE, built_in_sd=True)
                unmount.assert_not_called()
                raw_open.assert_not_called()

    def test_builtin_uses_registry_and_external_keeps_diskutil_info(self):
        with patch.object(CARD, "built_in_sd_info", return_value=card_info()) as registry, \
                patch.object(CARD, "disk_info", return_value=root_info()) as metadata:
            CARD.check_card("disk6", SIZE, built_in_sd=True, unmount=False)
            registry.assert_called_once_with("disk6")
            metadata.assert_called_once_with("/")
        external = card_info(Internal=False, BusProtocol="USB")
        with patch.object(CARD, "built_in_sd_info") as registry, \
                patch.object(CARD, "disk_info", side_effect=[external, root_info()]) as metadata:
            CARD.check_card("disk6", SIZE, unmount=False)
            registry.assert_not_called()
            self.assertEqual([call.args[0] for call in metadata.call_args_list], ["disk6", "/"])

    def test_registry_identity_change_during_unmount_stops(self):
        before = card_info(RegistryEntryID=4295553358)
        after = card_info(RegistryEntryID=4295553359)
        with patch.object(CARD, "built_in_sd_info", side_effect=[before, after]), \
                patch.object(CARD, "disk_info", return_value=root_info()), \
                patch.object(CARD.subprocess, "run"), \
                patch.object(CARD.os, "open") as raw_open:
            with self.assertRaisesRegex(SystemExit, "identity changed"):
                CARD.check_card("disk6", SIZE, built_in_sd=True)
            raw_open.assert_not_called()


class PrefixAndWriteGuards(QuietProgressTestCase):
    def test_only_safe_mbr_layout_is_accepted(self):
        with contextlib.redirect_stdout(io.StringIO()):
            CARD.check_layout(prefix())
        unsafe = (prefix(start=2048), prefix(partition_type=0xEE),
                  prefix(partition_type=0), bytes(CARD.PREFIX_SIZE))
        for data in unsafe:
            with self.subTest(data=data[:512]), self.assertRaises(SystemExit):
                CARD.check_layout(data)

    def test_existing_backup_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            backup = Path(directory) / "prefix.bin.gz"
            original = gzip.compress(prefix())
            backup.write_bytes(original)
            with patch.object(CARD, "BACKUP_PATH", backup), \
                    patch.object(CARD, "read_prefix", return_value=prefix()), \
                    patch.object(CARD.os, "umask"), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(FileExistsError):
                    CARD.backup(RAW)
            self.assertEqual(backup.read_bytes(), original)

    def test_changed_card_or_bad_stub_aborts_before_write(self):
        before = prefix()
        stub = b"S" * CARD.STUB_SIZE
        with patch.object(CARD, "load_stub", return_value=stub), \
                patch.object(CARD, "load_backup", return_value=before), \
                patch.object(CARD, "read_prefix", return_value=b"X" * CARD.PREFIX_SIZE), \
                patch.object(CARD, "write_region") as write:
            with self.assertRaisesRegex(SystemExit, "no longer matches"):
                CARD.write(RAW)
            write.assert_not_called()
        with tempfile.TemporaryDirectory() as directory:
            bad_stub = Path(directory) / "stub.bin"
            wrong_hash = bytearray(CARD.STUB_SIZE)
            wrong_hash[4:12] = b"eGON.BT0"
            for data, message in ((b"X" * CARD.STUB_SIZE, "wrong size or magic"),
                                  (wrong_hash, "SHA-256 mismatch")):
                bad_stub.write_bytes(data)
                with patch.object(CARD, "STUB_PATH", bad_stub), \
                        patch.object(CARD, "write_region") as write:
                    with self.assertRaisesRegex(SystemExit, message):
                        CARD.write(RAW)
                    write.assert_not_called()

    def test_restore_accepts_only_original_or_exact_stubbed_prefix(self):
        before = prefix()
        stub = b"S" * CARD.STUB_SIZE
        expected = before[:CARD.STUB_OFFSET] + stub + before[CARD.STUB_OFFSET + CARD.STUB_SIZE:]
        for current in (before, expected, b"X" * CARD.PREFIX_SIZE):
            with self.subTest(current_matches_original=current == before), \
                    patch.object(CARD, "load_stub", return_value=stub), \
                    patch.object(CARD, "load_backup", return_value=before), \
                    patch.object(CARD, "read_prefix", return_value=current), \
                    patch.object(CARD, "write_region") as write, \
                    contextlib.redirect_stdout(io.StringIO()):
                if current in (before, expected):
                    CARD.restore(RAW)
                    write.assert_called_once_with(
                        RAW, before[8192:16384], before, (before, expected),
                    )
                else:
                    with self.assertRaisesRegex(SystemExit, "neither the backup nor the stubbed state"):
                        CARD.restore(RAW)
                    write.assert_not_called()

    def test_two_prefix_reads_must_be_full_and_identical(self):
        for reads in ((b"short", b"short"), (prefix(), b"X" * CARD.PREFIX_SIZE)):
            with self.subTest(lengths=[len(data) for data in reads]), \
                    patch.object(CARD.os, "pread", side_effect=reads):
                with self.assertRaises(SystemExit):
                    CARD.read_prefix_fd(42)

    def test_raw_device_cannot_be_a_regular_file_or_symlink(self):
        for mode in (stat.S_IFREG | 0o600, stat.S_IFLNK | 0o777):
            with self.subTest(mode=mode), \
                    patch.object(CARD.os, "lstat", return_value=types.SimpleNamespace(st_mode=mode)), \
                    patch.object(CARD.os, "open") as raw_open:
                with self.assertRaisesRegex(SystemExit, "not a character device"):
                    CARD.open_raw_device(RAW, os.O_RDWR)
                raw_open.assert_not_called()

    def test_raw_open_does_not_follow_links_and_rechecks_descriptor_type(self):
        with patch.object(CARD.os, "lstat", return_value=types.SimpleNamespace(st_mode=stat.S_IFCHR)), \
                patch.object(CARD.os, "open", return_value=42) as raw_open, \
                patch.object(CARD.os, "fstat", return_value=types.SimpleNamespace(st_mode=stat.S_IFREG)), \
                patch.object(CARD.os, "close") as close:
            with self.assertRaisesRegex(SystemExit, "opened disk is not a character device"):
                CARD.open_raw_device(RAW, os.O_RDWR)
            raw_open.assert_called_once_with(RAW, os.O_RDWR | os.O_NOFOLLOW)
            close.assert_called_once_with(42)

    def test_exact_write_and_full_prefix_readback(self):
        before = prefix()
        stub = b"S" * CARD.STUB_SIZE
        expected = before[:CARD.STUB_OFFSET] + stub + before[CARD.STUB_OFFSET + CARD.STUB_SIZE:]
        with patch.object(CARD, "open_raw_device", return_value=42), \
                patch.object(CARD, "read_prefix_fd", return_value=before), \
                patch.object(CARD.os, "pwrite", return_value=CARD.STUB_SIZE) as write, \
                patch.object(CARD.os, "fsync") as flush, \
                patch.object(CARD.os, "close") as close, \
                patch.object(CARD, "read_prefix", return_value=expected):
            CARD.write_region(RAW, stub, expected, (before,))
            write.assert_called_once_with(42, stub, 8192)
            flush.assert_called_once_with(42)
            close.assert_called_once_with(42)

    def test_card_changed_after_open_aborts_before_pwrite(self):
        before = prefix()
        stub = b"S" * CARD.STUB_SIZE
        expected = before[:CARD.STUB_OFFSET] + stub + before[CARD.STUB_OFFSET + CARD.STUB_SIZE:]
        with patch.object(CARD, "open_raw_device", return_value=42), \
                patch.object(CARD, "read_prefix_fd", return_value=b"X" * CARD.PREFIX_SIZE), \
                patch.object(CARD.os, "pwrite") as write, \
                patch.object(CARD.os, "close") as close:
            with self.assertRaisesRegex(SystemExit, "changed before the write"):
                CARD.write_region(RAW, stub, expected, (before,))
            write.assert_not_called()
            close.assert_called_once_with(42)

    def test_short_write_or_bad_readback_stops(self):
        before = prefix()
        stub = b"S" * CARD.STUB_SIZE
        expected = before[:CARD.STUB_OFFSET] + stub + before[CARD.STUB_OFFSET + CARD.STUB_SIZE:]
        for written, readback, message in (
            (512, expected, "short write"),
            (CARD.STUB_SIZE, before, "card readback mismatch"),
        ):
            with self.subTest(message=message), \
                    patch.object(CARD, "open_raw_device", return_value=42), \
                    patch.object(CARD, "read_prefix_fd", return_value=before), \
                    patch.object(CARD.os, "pwrite", return_value=written), \
                    patch.object(CARD.os, "fsync"), \
                    patch.object(CARD.os, "close"), \
                    patch.object(CARD, "read_prefix", return_value=readback):
                with self.assertRaisesRegex(SystemExit, message):
                    CARD.write_region(RAW, stub, expected, (before,))


class ProgressReporting(unittest.TestCase):
    def test_progress_flushes_each_message(self):
        with patch("builtins.print") as display:
            CARD.progress("Checking card metadata...")
            display.assert_called_once_with("Checking card metadata...", flush=True)

    def test_raw_read_reports_before_and_after_each_potentially_blocking_call(self):
        messages = []
        data = prefix()
        read_count = 0

        def open_card(path, flags):
            self.assertEqual(path, RAW)
            self.assertEqual(flags, os.O_RDONLY | os.O_NOFOLLOW)
            self.assertEqual(messages[-1], f"Opening raw card read-only: {RAW}...")
            return 42

        def read_card(fd, size, offset):
            nonlocal read_count
            read_count += 1
            self.assertEqual((fd, size, offset), (42, CARD.PREFIX_SIZE, 0))
            self.assertEqual(messages[-1],
                             f"Reading prefix pass {read_count}/2: {CARD.PREFIX_SIZE} bytes at offset 0...")
            return data

        def close_card(fd):
            self.assertEqual(fd, 42)
            self.assertEqual(messages[-1], "Closing raw card device...")

        with patch.object(CARD, "progress", side_effect=messages.append), \
                patch.object(CARD.os, "lstat", return_value=types.SimpleNamespace(st_mode=stat.S_IFCHR)), \
                patch.object(CARD.os, "fstat", return_value=types.SimpleNamespace(st_mode=stat.S_IFCHR)), \
                patch.object(CARD.os, "open", side_effect=open_card), \
                patch.object(CARD.os, "pread", side_effect=read_card), \
                patch.object(CARD.os, "close", side_effect=close_card):
            self.assertEqual(CARD.read_prefix(RAW), data)
        self.assertEqual(messages, [
            f"Opening raw card read-only: {RAW}...", "Raw card device opened.",
            f"Reading prefix pass 1/2: {CARD.PREFIX_SIZE} bytes at offset 0...",
            f"Prefix pass 1/2 returned {CARD.PREFIX_SIZE} bytes.",
            f"Reading prefix pass 2/2: {CARD.PREFIX_SIZE} bytes at offset 0...",
            f"Prefix pass 2/2 returned {CARD.PREFIX_SIZE} bytes.",
            "Closing raw card device...", "Raw card device closed.",
        ])

    def test_metadata_and_unmount_reports_bracket_the_existing_checks(self):
        messages = []
        inspect_count = 0

        def inspect(identifier, size, built_in):
            nonlocal inspect_count
            inspect_count += 1
            expected = ("Checking disk6 metadata..." if inspect_count == 1
                        else "Rechecking disk6 identity after unmount...")
            self.assertEqual(messages[-1], expected)
            return card_info()

        def unmount(*args, **kwargs):
            self.assertEqual(messages[-1], "Unmounting disk6...")

        with patch.object(CARD, "progress", side_effect=messages.append), \
                patch.object(CARD, "inspect_card", side_effect=inspect), \
                patch.object(CARD.subprocess, "run", side_effect=unmount), \
                patch.object(CARD.subprocess, "check_output", return_value=""):
            self.assertEqual(CARD.check_card("disk6", SIZE, built_in_sd=True), RAW)
        self.assertEqual(inspect_count, 2)
        self.assertEqual(messages[-1], "Card unmounted and identity verified.")

    def test_backup_reports_read_only_access_save_and_successful_verification(self):
        messages = []
        data = prefix()
        with tempfile.TemporaryDirectory() as directory:
            backup = Path(directory) / "prefix.bin.gz"
            with patch.object(CARD, "progress", side_effect=messages.append), \
                    patch.object(CARD, "BACKUP_PATH", backup), \
                    patch.object(CARD, "read_prefix", return_value=data), \
                    patch.object(CARD.os, "umask"), \
                    contextlib.redirect_stdout(io.StringIO()):
                CARD.backup(RAW)
            self.assertEqual(gzip.decompress(backup.read_bytes()), data)
            self.assertEqual(messages, [
                "Backing up the card prefix; card access is read-only.",
                f"Saving card prefix backup to {backup}...",
                "Verifying saved prefix backup...",
                f"Saved prefix backup verified: {CARD.PREFIX_SIZE} bytes.",
            ])


if __name__ == "__main__":
    unittest.main()
