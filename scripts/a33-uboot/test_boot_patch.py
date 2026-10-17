"""Synthetic boot-image and generated-shell tests. Never reads a real device/backup."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zlib


SCRIPT = Path(__file__).with_name("boot-patch.py")
SPEC = importlib.util.spec_from_file_location("boot_patch", SCRIPT)
PATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCH)


def cpio(files):
    result = bytearray()
    for number, (name, content) in enumerate(list(files.items()) + [("TRAILER!!!", b"")]):
        name = name.encode() + b"\0"
        fields = [number + 1, 0o100644, 0, 0, 1, 0, len(content), 0, 0, 0, 0, len(name), 0]
        record = b"070701" + b"".join(f"{field:08x}".encode() for field in fields) + name
        record += bytes(-len(record) % 4)
        record += content
        record += bytes(-len(record) % 4)
        result += record
    return bytes(result)


def boot_fixture(action=None):
    kernel = b"synthetic immutable kernel" * 50
    archive = cpio({
        "default.prop": b"ro.secure=0\nro.adb.secure=0\nro.debuggable=1\n",
        "init.sun8i.usb.rc": PATCH.OLD_ACTION if action is None else action,
        "sbin/adbd": b"synthetic daemon",
    })
    ramdisk = gzip.compress(archive, mtime=0)
    pad = lambda count: (count + 2047) // 2048 * 2048
    header = bytearray(2048)
    struct.pack_into("<8s8I", header, 0, b"ANDROID!", len(kernel), 0, len(ramdisk), 0, 0, 0, 0, 2048)
    digest = hashlib.sha1()
    for part in (kernel, ramdisk, b""):
        digest.update(part)
        digest.update(struct.pack("<I", len(part)))
    header[576:608] = digest.digest() + bytes(12)
    return bytes(header) + kernel + bytes(pad(len(kernel)) - len(kernel)) + ramdisk + bytes(pad(len(ramdisk)) - len(ramdisk)) + b"T" * 2048


def payload_fixture():
    payloads = {
        "orig_header": b"H" * 1024, "new_header": b"h" * 1024,
        "orig_ramdisk": b"R" * 1536, "new_ramdisk": b"r" * 1536,
    }
    parameters = {
        "header_sector": 0x100, "header_sectors": 2,
        "ramdisk_sector": 0x108, "ramdisk_sectors": 3,
        "crc": {name: f"{zlib.crc32(data):08x}" for name, data in payloads.items()},
    }
    return payloads, parameters


FAKE_COMMAND = r'''
import json
from pathlib import Path
import sys
import zlib

root = Path(__file__).resolve().parent
path = root / "state.json"
state = json.loads(path.read_text())
name, args = Path(sys.argv[0]).name, sys.argv[1:]
operation = " ".join([name, args[0]]) if name == "mmc" else name
number = state["counts"].get(operation, 0) + 1
state["counts"][operation] = number
state["trace"].append([operation, args])
mutation = state.get("mutate_before", {}).get(f"{operation}:{number}")
if mutation:
    if mutation.get("memory"):
        state["memory"][str(mutation["address"])] = mutation["hex"]
    else:
        state["media"]["1"][str(mutation["sector"])] = mutation["hex"]
if operation == "mmc write":
    state["write_attempts"].append([state["selected"], int(args[2], 0)])
status = 0
if number in state.get("fail", {}).get(operation, []):
    status = 1
elif operation == "mmc dev":
    if len(args) != 3 or args[2] != "0":
        status = 1
    else:
        state["selected"] = str(int(args[1], 0))
elif operation == "mmc read":
    address, sector, sectors = [int(arg, 0) for arg in args[1:]]
    data = bytes.fromhex(state["media"][state["selected"]].get(str(sector), ""))
    if len(data) != sectors * 512:
        status = 1
    else:
        state["memory"][str(address)] = data.hex()
elif operation == "mmc write":
    address, sector, sectors = [int(arg, 0) for arg in args[1:]]
    data = bytes.fromhex(state["memory"].get(str(address), ""))
    if len(data) < sectors * 512:
        status = 1
    else:
        state["media"][state["selected"]][str(sector)] = data[:sectors * 512].hex()
        state["successful_writes"].append([state["selected"], sector])
elif operation == "crc32":
    address, length = int(args[1], 0), int(args[2], 0)
    data = bytes.fromhex(state["memory"].get(str(address), ""))
    status = int(len(data) < length or f"{zlib.crc32(data[:length]):08x}" != args[3])
elif operation == "cmp.b":
    first, second, length = [int(arg, 0) for arg in args]
    left = bytes.fromhex(state["memory"].get(str(first), ""))
    right = bytes.fromhex(state["memory"].get(str(second), ""))
    status = int(len(left) < length or len(right) < length or left[:length] != right[:length])
elif operation != "ums":
    raise AssertionError(f"unexpected fake command {operation}")
path.write_text(json.dumps(state))
sys.exit(status)
'''


def execute(direction, *, fail=None, media=None, mutate_before=None, payload_change=None):
    payloads, parameters = payload_fixture()
    expect, write = ("orig", "new") if direction == "write" else ("new", "orig")
    memory = {str(PATCH.ADDR[name]): data.hex() for name, data in payloads.items()}
    for part in ("header", "ramdisk"):
        # Failed reads leave an exact expected-source scratch buffer behind.
        memory[str(PATCH.ADDR[f"read_{part}"])] = payloads[f"{expect}_{part}"].hex()
    if payload_change:
        memory[str(PATCH.ADDR[payload_change])] = b"?".hex() * len(payloads[payload_change])
    flash = {str(parameters[f"{part}_sector"]): (media or {}).get(part, payloads[f"{expect}_{part}"]).hex()
             for part in ("header", "ramdisk")}
    state = {
        "selected": "0", "memory": memory, "media": {"0": dict(flash), "1": dict(flash)},
        "counts": {}, "trace": [], "write_attempts": [], "successful_writes": [],
        "fail": fail or {}, "mutate_before": mutate_before or {},
    }
    source = PATCH.guarded_script("Synthetic boot test", expect, write,
                                  allow_partial=direction == "restore", **parameters)
    with tempfile.TemporaryDirectory(prefix="a33-boot-guards-synthetic-") as directory:
        root = Path(directory)
        command = root / "fake_command.py"
        command.write_text(f"#!{sys.executable}\n" + FAKE_COMMAND)
        command.chmod(0o700)
        for name in ["mmc", "crc32", "cmp.b", "ums"]:
            (root / name).symlink_to(command.name)
        (root / "state.json").write_text(json.dumps(state))
        shell = root / "synthetic.sh"
        shell.write_text('setenv() { export "$1=$2"; }\n' + source)
        completed = subprocess.run(["/bin/sh", str(shell)], env={"PATH": f"{root}:/usr/bin:/bin"},
                                   capture_output=True, text=True, timeout=10)
        if completed.returncode:
            raise AssertionError(f"generated shell failed: {completed.stderr}")
        return json.loads((root / "state.json").read_text()), completed.stdout


class BootScriptGuardTests(unittest.TestCase):
    def test_failed_selection_never_reads_or_writes_prior_device(self):
        for direction in ["write", "restore"]:
            with self.subTest(direction=direction):
                state, output = execute(direction, fail={"mmc dev": [1]})
                self.assertEqual(state["write_attempts"], [])
                self.assertNotIn("mmc read", state["counts"])
                self.assertIn("select FAILED", output)

    def test_either_preflight_read_failure_cannot_use_matching_stale_memory(self):
        for direction in ["write", "restore"]:
            for number in [1, 2]:
                with self.subTest(direction=direction, read=number):
                    state, _ = execute(direction, fail={"mmc read": [number]})
                    self.assertEqual(state["write_attempts"], [])

    def test_each_payload_crc_failure_refuses_all_writes(self):
        for direction in ["write", "restore"]:
            for payload in payload_fixture()[0]:
                with self.subTest(direction=direction, payload=payload):
                    state, _ = execute(direction, payload_change=payload)
                    self.assertEqual(state["write_attempts"], [])

    def test_each_unexpected_source_range_refuses_all_writes(self):
        for direction in ["write", "restore"]:
            for part, length in [("header", 1024), ("ramdisk", 1536)]:
                with self.subTest(direction=direction, part=part):
                    state, _ = execute(direction, media={part: b"?" * length})
                    self.assertEqual(state["write_attempts"], [])

    def test_failed_ramdisk_source_reread_cannot_write(self):
        for direction in ["write", "restore"]:
            with self.subTest(direction=direction):
                state, _ = execute(direction, fail={"mmc read": [3]})
                self.assertEqual(state["write_attempts"], [])

    def test_ramdisk_write_or_readback_failure_never_commits_header(self):
        for direction in ["write", "restore"]:
            for failure in [{"mmc write": [1]}, {"mmc read": [4]}, {"cmp.b": [4]}]:
                with self.subTest(direction=direction, fail=failure):
                    state, output = execute(direction, fail=failure)
                    self.assertTrue(all(sector == 0x108 for _, sector in state["write_attempts"]))
                    self.assertNotIn("boot patch complete", output)

    def test_late_ramdisk_source_change_never_writes(self):
        for direction in ["write", "restore"]:
            with self.subTest(direction=direction):
                state, _ = execute(direction, mutate_before={"mmc read:3": {"sector": 0x108, "hex": (b"?" * 1536).hex()}})
                self.assertEqual(state["write_attempts"], [])

    def test_header_source_read_failure_leaves_header_untouched(self):
        for direction in ["write", "restore"]:
            with self.subTest(direction=direction):
                state, output = execute(direction, fail={"mmc read": [5]})
                self.assertEqual(state["write_attempts"], [["1", 0x108]])
                self.assertNotIn("boot patch complete", output)

    def test_header_write_or_readback_failure_is_not_reported_complete(self):
        for direction in ["write", "restore"]:
            for failure in [{"mmc write": [2]}, {"mmc read": [6]}]:
                with self.subTest(direction=direction, fail=failure):
                    state, output = execute(direction, fail=failure)
                    self.assertEqual(state["write_attempts"], [["1", 0x108], ["1", 0x100]])
                    self.assertNotIn("boot patch complete", output)
                    self.assertIn("header write or readback FAILED", output)

    def test_bad_readback_bytes_never_complete_or_commit_a_later_range(self):
        for direction in ["write", "restore"]:
            for read, sector, size in [(4, 0x108, 1536), (6, 0x100, 1024)]:
                with self.subTest(direction=direction, read=read):
                    state, output = execute(direction, mutate_before={
                        f"mmc read:{read}": {"sector": sector, "hex": (b"?" * size).hex()},
                    })
                    expected = [["1", 0x108]] if read == 4 else [["1", 0x108], ["1", 0x100]]
                    self.assertEqual(state["write_attempts"], expected)
                    self.assertNotIn("boot patch complete", output)

    def test_late_header_source_or_payload_change_cannot_commit_header(self):
        for direction in ["write", "restore"]:
            for mutation in [
                {"sector": 0x100, "hex": (b"?" * 1024).hex()},
                {"memory": True, "address": PATCH.ADDR["orig_header"], "hex": (b"?" * 1024).hex()},
            ]:
                with self.subTest(direction=direction, mutation=mutation):
                    state, _ = execute(direction, mutate_before={"mmc read:5": mutation})
                    self.assertEqual(state["write_attempts"], [["1", 0x108]])

    def test_success_commits_ramdisk_then_header_and_verifies_both(self):
        payloads, parameters = payload_fixture()
        for direction in ["write", "restore"]:
            with self.subTest(direction=direction):
                state, output = execute(direction)
                self.assertEqual(state["successful_writes"], [["1", 0x108], ["1", 0x100]])
                target = "new" if direction == "write" else "orig"
                for part in ["header", "ramdisk"]:
                    self.assertEqual(state["media"]["1"][str(parameters[f"{part}_sector"])], payloads[f"{target}_{part}"].hex())
                self.assertEqual(state["counts"]["mmc read"], 6)
                self.assertIn("boot patch complete and read back", output)

    def test_partial_restore_only_writes_ranges_still_patched(self):
        payloads, _ = payload_fixture()
        for already in ["header", "ramdisk"]:
            with self.subTest(already=already):
                state, output = execute("restore", media={already: payloads[f"orig_{already}"]})
                expected_sector = 0x108 if already == "header" else 0x100
                self.assertEqual(state["successful_writes"], [["1", expected_sector]])
                self.assertIn("boot patch complete", output)

    def test_original_restore_is_noop_and_forward_refuses_mixed_state(self):
        payloads, _ = payload_fixture()
        state, output = execute("restore", media={"header": payloads["orig_header"], "ramdisk": payloads["orig_ramdisk"]})
        self.assertEqual(state["write_attempts"], [])
        self.assertIn("boot patch complete", output)
        state, _ = execute("write", media={"ramdisk": payloads["new_ramdisk"]})
        self.assertEqual(state["write_attempts"], [])

    def test_compiled_image_matches_text_and_header_data_crcs(self):
        _, parameters = payload_fixture()
        source = PATCH.guarded_script("Synthetic test", "orig", "new", **parameters)
        image = PATCH.script_image(source.encode())
        header = bytearray(image[:64])
        expected = struct.unpack_from(">I", header, 4)[0]
        struct.pack_into(">I", header, 4, 0)
        self.assertEqual(zlib.crc32(header), expected)
        self.assertEqual(struct.unpack_from(">I", image, 24)[0], zlib.crc32(image[64:]))
        self.assertEqual(image[72:], source.encode())


class HostBootImageTests(unittest.TestCase):
    def test_offline_patch_changes_only_usb_action_header_size_and_id(self):
        old = boot_fixture()
        new, offset, slot = PATCH.build(old)
        self.assertEqual(PATCH.verify(old, new, offset, slot), 2)
        old_kernel, _, _, _ = PATCH.parse_boot(old)
        new_kernel, _, _, archive = PATCH.parse_boot(new)
        self.assertEqual(old_kernel, new_kernel)
        records, _ = PATCH.cpio_records(archive)
        contents = {name: data for name, _, _, data in records}
        self.assertEqual(contents[b"init.sun8i.usb.rc"], PATCH.NEW_ACTION)
        self.assertEqual(old[offset + slot:], new[offset + slot:])

    def test_truncated_partition_or_declared_payload_outside_partition_refuses(self):
        old = boot_fixture()
        for image in [old[:1024], old[:-1], old[:4096]]:
            with self.subTest(size=len(image)), self.assertRaises(SystemExit):
                PATCH.build(image)

    def test_missing_duplicate_or_changed_stock_action_refuses(self):
        for action in [b"other action\n", PATCH.OLD_ACTION * 2, PATCH.OLD_ACTION.replace(b"1000", b"9999")]:
            with self.subTest(action=action[:20]), self.assertRaises(SystemExit):
                PATCH.build(boot_fixture(action))

    def test_kernel_tampering_bad_id_or_page_size_refuses(self):
        for offset in [2050, 576, 36]:
            old = bytearray(boot_fixture())
            old[offset] ^= 1
            with self.subTest(offset=offset), self.assertRaises(SystemExit):
                PATCH.build(bytes(old))

    def test_verify_rejects_changes_beyond_ramdisk_and_size_changes(self):
        old = boot_fixture()
        new, offset, slot = PATCH.build(old)
        tampered = bytearray(new)
        tampered[-1] ^= 1
        for image in [bytes(tampered), new[:-512]]:
            with self.assertRaises(SystemExit):
                PATCH.verify(old, image, offset, slot)

    def test_invalid_generated_ranges_or_crc_do_not_generate_scripts(self):
        _, parameters = payload_fixture()
        for change in [{"header_sector": -1}, {"ramdisk_sector": 0x100}, {"ramdisk_sectors": 0}, {"crc": {}}]:
            with self.subTest(change=change), self.assertRaises(SystemExit):
                PATCH.guarded_script("Synthetic test", "orig", "new", **{**parameters, **change})

    def test_main_refuses_existing_plan_instead_of_overwriting_undo_payloads(self):
        boot = boot_fixture()
        # Tiny synthetic MBR image, not the real frame's sector layout.
        sectors = len(boot) // 512
        mbr = bytearray(512)
        mbr[450] = 0x83
        struct.pack_into("<II", mbr, 454, 2, sectors)
        mbr[510:] = b"\x55\xaa"
        with tempfile.TemporaryDirectory(prefix="a33-boot-host-synthetic-") as directory:
            root = Path(directory)
            image = root / "synthetic.img"
            image.write_bytes(bytes(mbr) + bytes(512) + boot)
            out = root / "existing-plan"
            out.mkdir()
            retained = out / "undo-sentinel"
            retained.write_bytes(b"must survive")
            with mock.patch.object(PATCH, "OUT", out), mock.patch.object(sys, "argv", [str(SCRIPT), str(image), "2"]):
                with self.assertRaises(SystemExit):
                    PATCH.main()
            self.assertEqual(list(out.iterdir()), [retained])
            self.assertEqual(retained.read_bytes(), b"must survive")


if __name__ == "__main__":
    unittest.main()
