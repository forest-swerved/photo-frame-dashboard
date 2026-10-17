"""Synthetic shell execution of generated guards; no device or backup access.

Only fake mmc/crc32/cmp.b/ums commands in a TemporaryDirectory are executed.
Failed fake reads deliberately leave stale, matching RAM behind, reproducing
the failure mode that an unchecked mmc read would otherwise fail open on.
"""
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib


SCRIPT = Path(__file__).with_name("data-patch-prepare.py")
SPEC = importlib.util.spec_from_file_location("data_patch_prepare", SCRIPT)
PATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCH)


FAKE_COMMAND = r'''
import json
from pathlib import Path
import sys
import zlib

root = Path(__file__).resolve().parent
path = root / "state.json"
state = json.loads(path.read_text())
name = Path(sys.argv[0]).name
args = sys.argv[1:]
operation = " ".join([name, args[0]]) if name == "mmc" else name
number = state["counts"].get(operation, 0) + 1
state["counts"][operation] = number
state["trace"].append([operation, args])
if operation == "mmc write":
    state["write_attempts"].append([state["selected"], int(args[2], 0)])
mutation = state.get("mutate_before", {}).get(f"{operation}:{number}")
if mutation:
    state["media"][mutation["device"]][str(mutation["sector"])] = mutation["hex"]
status = 0
if number in state.get("fail", {}).get(operation, []):
    status = 1
elif operation == "mmc dev":
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


def ranges():
    result = []
    for i in range(2):
        # These are deliberately synthetic addresses/sectors, not a unit plan.
        base = 0x10000 + i * 0x10000
        orig = bytes([65 + i]) * 512
        new = bytes([97 + i]) * 512
        result.append({
            "range": i, "sector": 0x100 + i * 4, "sectors": 1, "length": 512,
            "orig_addr": base, "new_addr": base + 0x1000, "read_addr": base + 0x2000,
            "orig_crc32": f"{zlib.crc32(orig):08x}", "new_crc32": f"{zlib.crc32(new):08x}",
            "orig": orig.hex(), "new": new.hex(),
        })
    return result


def execute(kind, *, fail=None, media=None, mutate_before=None):
    writes = ranges()
    expected = "new" if kind == "restore" else "orig"
    memory = {}
    flash = {}
    for w in writes:
        memory[str(w["orig_addr"])] = w["orig"]
        memory[str(w["new_addr"])] = w["new"]
        # A failed read leaves a matching scratch buffer: status must gate writes.
        memory[str(w["read_addr"])] = w[expected]
        flash[str(w["sector"])] = (media or {}).get(w["range"], w[expected])
    state = {
        "selected": "0", "memory": memory,
        "media": {"0": dict(flash), "1": dict(flash)},
        "counts": {}, "trace": [], "write_attempts": [], "successful_writes": [],
        "fail": fail or {}, "mutate_before": mutate_before or {},
    }
    source = PATCH.restore_script(writes) if kind == "restore" else PATCH.guarded_script(writes, "Synthetic test", "orig", "new")
    with tempfile.TemporaryDirectory(prefix="a33-guards-synthetic-") as directory:
        root = Path(directory)
        command = root / "fake_command.py"
        command.write_text(f"#!{sys.executable}\n" + FAKE_COMMAND)
        command.chmod(0o700)
        for name in ["mmc", "crc32", "cmp.b", "ums"]:
            (root / name).symlink_to(command.name)
        (root / "state.json").write_text(json.dumps(state))
        shell = root / "synthetic.sh"
        shell.write_text('setenv() { export "$1=$2"; }\n' + source)
        # A clean synthetic environment: no application env or credential reads.
        completed = subprocess.run(["/bin/sh", str(shell)], env={"PATH": f"{root}:/usr/bin:/bin"},
                                   capture_output=True, text=True, timeout=10)
        if completed.returncode:
            raise AssertionError(f"generated shell failed: {completed.stderr}")
        return json.loads((root / "state.json").read_text()), completed.stdout


class DataPatchGuardTests(unittest.TestCase):
    def both(self):
        return ["write", "restore"]

    def test_select_failure_cannot_read_or_write_previous_device(self):
        for kind in self.both():
            with self.subTest(kind=kind):
                state, output = execute(kind, fail={"mmc dev": [1]})
                self.assertEqual(state["write_attempts"], [])
                self.assertNotIn("mmc read", state["counts"])
                self.assertIn("select FAILED", output)

    def test_every_preflight_read_failure_refuses_all_writes_despite_matching_stale_ram(self):
        for kind in self.both():
            for read in [1, 2]:
                with self.subTest(kind=kind, read=read):
                    state, _ = execute(kind, fail={"mmc read": [read]})
                    self.assertEqual(state["write_attempts"], [])

    def test_phase_two_read_failure_refuses_writes_despite_matching_stale_ram(self):
        for kind in self.both():
            with self.subTest(kind=kind):
                state, _ = execute(kind, fail={"mmc read": [3]})
                self.assertEqual(state["write_attempts"], [])

    def test_every_preflight_payload_crc_failure_refuses_all_writes(self):
        for kind in self.both():
            for crc in [1, 2, 3, 4]:
                with self.subTest(kind=kind, crc=crc):
                    state, _ = execute(kind, fail={"crc32": [crc]})
                    self.assertEqual(state["write_attempts"], [])

    def test_payload_crcs_are_checked_again_before_phase_two_writes(self):
        for kind in self.both():
            for crc in [5, 6]:
                with self.subTest(kind=kind, crc=crc):
                    state, _ = execute(kind, fail={"crc32": [crc]})
                    self.assertEqual(state["write_attempts"], [])

    def test_unexpected_preflight_source_refuses_all_ranges(self):
        for kind in self.both():
            with self.subTest(kind=kind):
                state, _ = execute(kind, media={1: (b"?" * 512).hex()})
                self.assertEqual(state["write_attempts"], [])

    def test_source_changed_after_preflight_cannot_write_or_continue(self):
        change = {"mmc read:3": {"device": "1", "sector": ranges()[0]["sector"], "hex": (b"?" * 512).hex()}}
        for kind in self.both():
            with self.subTest(kind=kind):
                state, _ = execute(kind, mutate_before=change)
                self.assertEqual(state["write_attempts"], [])

    def test_readback_failure_stops_before_next_range(self):
        for kind in self.both():
            with self.subTest(kind=kind):
                state, output = execute(kind, fail={"mmc read": [4]})
                self.assertEqual(state["write_attempts"], [["1", ranges()[0]["sector"]]])
                self.assertNotIn("all ranges written", output)

    def test_write_failure_stops_before_next_range(self):
        for kind in self.both():
            with self.subTest(kind=kind):
                state, _ = execute(kind, fail={"mmc write": [1]})
                self.assertEqual(state["write_attempts"], [["1", ranges()[0]["sector"]]])
                self.assertEqual(state["successful_writes"], [])

    def test_success_writes_only_selected_device_and_each_readback_matches(self):
        for kind in self.both():
            with self.subTest(kind=kind):
                state, _ = execute(kind)
                self.assertEqual(state["successful_writes"], [["1", w["sector"]] for w in ranges()])
                target = "orig" if kind == "restore" else "new"
                source = "new" if kind == "restore" else "orig"
                for w in ranges():
                    self.assertEqual(state["media"]["1"][str(w["sector"])], w[target])
                    self.assertEqual(state["media"]["0"][str(w["sector"])], w[source])

    def test_partial_restore_skips_original_range_and_restores_only_edited_range(self):
        writes = ranges()
        state, output = execute("restore", media={0: writes[0]["orig"]})
        self.assertEqual(state["successful_writes"], [["1", writes[1]["sector"]]])
        self.assertIn("already original", output)

    def test_restore_late_unexpected_source_does_not_touch_that_range(self):
        change = {"mmc read:5": {"device": "1", "sector": ranges()[1]["sector"], "hex": (b"?" * 512).hex()}}
        state, _ = execute("restore", mutate_before=change)
        self.assertEqual(state["write_attempts"], [["1", ranges()[0]["sector"]]])

    def test_empty_plans_do_not_generate_executable_scripts(self):
        with self.assertRaises(ValueError):
            PATCH.guarded_script([], "Synthetic test", "orig", "new")
        with self.assertRaises(ValueError):
            PATCH.restore_script([])

    def test_compiled_script_contains_exact_guarded_text_and_valid_header_crcs(self):
        for source in [PATCH.guarded_script(ranges(), "Synthetic test", "orig", "new"), PATCH.restore_script(ranges())]:
            with self.subTest(source=source.splitlines()[0]):
                image = PATCH.script_image(source.encode())
                header = bytearray(image[:64])
                stored_header_crc = struct.unpack_from(">I", header, 4)[0]
                struct.pack_into(">I", header, 4, 0)
                self.assertEqual(zlib.crc32(header), stored_header_crc)
                self.assertEqual(struct.unpack_from(">I", image, 24)[0], zlib.crc32(image[64:]))
                self.assertEqual(image[72:], source.encode())


if __name__ == "__main__":
    unittest.main()
