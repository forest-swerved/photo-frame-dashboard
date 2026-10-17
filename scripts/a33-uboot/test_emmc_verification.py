"""Verification fixtures use only temporary regular files, never devices/backups."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock
import zlib


SCRIPT = Path(__file__).with_name("emmc-macos.py")
SPEC = importlib.util.spec_from_file_location("emmc_verification", SCRIPT)
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


class VerificationFixtures(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="a33-verification-synthetic-")
        self.root = Path(self.directory.name)
        self.image = self.root / "original.img"
        self.raw = self.root / "synthetic-read-only-view.img"
        self.plan_dir = self.root / "plan"
        self.plan_dir.mkdir()
        self.plan_path = self.plan_dir / "plan.json"
        self.state = self.root / "verify-state.json"
        self.original_state = self.root / "verify-original-state.json"
        self.size = 128 * 1024
        source = bytearray(b"S" * self.size)
        source[:512] = bytes(512)
        source[450] = 0x83
        struct.pack_into("<II", source, 454, 16, (self.size - 8192) // 512)
        source[510:512] = b"\x55\xaa"
        self.original = bytes(source)
        self.image.write_bytes(self.original)
        self.manifest = self.root / "a33-emmc-full.sha256"
        self.manifest.write_text(f"{hashlib.sha256(self.original).hexdigest()}  original.img\n")
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(self.directory.cleanup)
        for name, value in {
            "BACKUPS": self.root, "IMAGE": self.image, "PLAN": self.plan_path,
            "VERIFY_STATE": self.state, "ORIGINAL_VERIFY_STATE": self.original_state,
            "CHUNK": 4096, "SEGMENT": 16 * 1024,
        }.items():
            self.stack.enter_context(mock.patch.object(VERIFY, name, value))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.plan = self.write_data_plan()

    def write_data_plan(self, sector=192, sectors=1):
        start, length = sector * 512, sectors * 512
        orig = self.original[start:start + length]
        new = b"N" * length
        (self.plan_dir / "range-00.orig").write_bytes(orig)
        (self.plan_dir / "range-00.new").write_bytes(new)
        plan = {
            "partition_start_sector": 16,
            "source_orig_image": "synthetic-original-partition.img",
            "source_edited_image": "synthetic-edited-partition.img",
            "writes": [{
                "range": 0, "partition_relative_byte": start - 8192,
                "sector": sector, "sectors": sectors, "length": length,
                "orig_file": "range-00.orig", "new_file": "range-00.new",
                "orig_sha256": hashlib.sha256(orig).hexdigest(),
                "new_sha256": hashlib.sha256(new).hexdigest(),
                "orig_crc32": f"{zlib.crc32(orig):08x}", "new_crc32": f"{zlib.crc32(new):08x}",
            }],
        }
        self.save_plan(plan)
        self.raw.write_bytes(self.original[:start] + new + self.original[start + length:])
        return plan

    def save_plan(self, plan=None):
        self.plan_path.write_text(json.dumps(self.plan if plan is None else plan))

    def assert_stopped(self, callback):
        with self.assertRaises(SystemExit) as caught:
            callback()
        self.assertTrue(str(caught.exception).startswith("STOP:"))

    def test_data_plan_loads_exact_payload_and_full_verification_passes(self):
        patches, identity = VERIFY.load_verification_plan(self.plan_path, self.size)
        self.assertEqual(patches, [(192 * 512, b"N" * 512)])
        self.assertRegex(identity, r"^[0-9a-f]{64}$")
        VERIFY.verify(self.raw, self.size, plan_path=self.plan_path)
        VERIFY.verify_resume(self.raw, self.size, plan_path=self.plan_path)
        done = json.loads(self.state.with_suffix(".done.json").read_text())
        self.assertEqual(done["verification_version"], 2)
        self.assertEqual(done["plan_identity"], identity)
        self.assertEqual(len(done["done"]), self.size // VERIFY.SEGMENT)

    def test_boot_plan_schema_preserves_default_usage_and_validates_original_bytes(self):
        new = b"H" * 1024
        orig = self.original[192 * 512:194 * 512]
        (self.plan_dir / "orig-header.bin").write_bytes(orig)
        (self.plan_dir / "new-header.bin").write_bytes(new)
        self.save_plan({"writes": [{"sector": 192, "sectors": 2, "file": "new-header.bin"}],
                        "crc32": {"orig_header": f"{zlib.crc32(orig):08x}", "new_header": f"{zlib.crc32(new):08x}"}})
        self.raw.write_bytes(self.original[:192 * 512] + new + self.original[194 * 512:])
        VERIFY.verify(self.raw, self.size)

    def test_unrelated_changed_byte_fails_even_when_patch_sector_is_exact(self):
        data = bytearray(self.raw.read_bytes())
        data[-1] ^= 1
        self.raw.write_bytes(data)
        for function in [VERIFY.verify, VERIFY.verify_resume]:
            with self.subTest(function=function.__name__):
                self.assert_stopped(lambda: function(self.raw, self.size, plan_path=self.plan_path))

    def test_unwritten_or_partially_written_plan_never_passes(self):
        for raw in [self.original, self.original[:192 * 512] + b"N" * 511 + self.original[192 * 512 + 511:]]:
            self.raw.write_bytes(raw)
            self.assert_stopped(lambda: VERIFY.verify(self.raw, self.size, plan_path=self.plan_path))

    def test_backup_content_or_manifest_tampering_refuses(self):
        self.image.write_bytes(b"?" + self.original[1:])
        self.assert_stopped(lambda: VERIFY.verify(self.raw, self.size, plan_path=self.plan_path))
        self.image.write_bytes(self.original)
        self.manifest.write_text("not-a-hash")
        self.assert_stopped(lambda: VERIFY.verify(self.raw, self.size, plan_path=self.plan_path))

    def test_same_length_backup_mutation_after_hashing_cannot_redefine_expected_bytes(self):
        for function in [VERIFY.verify, VERIFY.verify_resume]:
            with self.subTest(function=function.__name__):
                self.image.write_bytes(self.original)
                self.raw.write_bytes(self.original[:192 * 512] + b"N" * 512 + self.original[193 * 512:])
                self.state.unlink(missing_ok=True)
                chunks = VERIFY.chunks
                changed = False
                def mutate(path, total, label, start=0):
                    nonlocal changed
                    if not changed:
                        changed = True
                        for target in [self.image, self.raw]:
                            value = bytearray(target.read_bytes())
                            value[-1] ^= 1
                            target.write_bytes(value)
                    yield from chunks(path, total, label, start)
                with mock.patch.object(VERIFY, "chunks", mutate):
                    self.assert_stopped(lambda: function(self.raw, self.size, plan_path=self.plan_path))
                self.assertFalse(self.state.with_suffix(".done.json").exists())

    def test_backup_path_replacement_after_hashing_cannot_substitute_an_open_source(self):
        chunks = VERIFY.chunks
        replacement = self.root / "replacement.img"
        replacement.write_bytes(self.original)
        changed = False
        def replace(path, total, label, start=0):
            nonlocal changed
            if not changed:
                changed = True
                replacement.replace(self.image)
            yield from chunks(path, total, label, start)
        with mock.patch.object(VERIFY, "chunks", replace):
            self.assert_stopped(lambda: VERIFY.verify(self.raw, self.size, plan_path=self.plan_path))

    def test_payload_sha_crc_size_and_original_backup_mismatch_refuse(self):
        for field, bad in [("new_sha256", "0" * 64), ("orig_sha256", "0" * 64),
                           ("new_crc32", "00000000"), ("orig_crc32", "00000000"), ("length", 511)]:
            plan = json.loads(json.dumps(self.plan))
            plan["writes"][0][field] = bad
            self.save_plan(plan)
            with self.subTest(field=field):
                self.assert_stopped(lambda: VERIFY.load_verification_plan(self.plan_path, self.size))
        self.save_plan()
        (self.plan_dir / "range-00.new").write_bytes(b"N" * 511)
        self.assert_stopped(lambda: VERIFY.load_verification_plan(self.plan_path, self.size))
        (self.plan_dir / "range-00.new").write_bytes(b"N" * 512)
        orig = b"X" * 512
        (self.plan_dir / "range-00.orig").write_bytes(orig)
        self.plan["writes"][0].update(orig_sha256=hashlib.sha256(orig).hexdigest(), orig_crc32=f"{zlib.crc32(orig):08x}")
        self.save_plan()
        self.assert_stopped(lambda: VERIFY.load_verification_plan(self.plan_path, self.size))

    def test_noninteger_negative_zero_outside_and_overlapping_ranges_refuse(self):
        for field, bad in [("sector", True), ("sector", -1), ("sectors", 0), ("sector", self.size // 512), ("sectors", "1")]:
            plan = json.loads(json.dumps(self.plan))
            plan["writes"][0][field] = bad
            self.save_plan(plan)
            with self.subTest(field=field, value=bad):
                self.assert_stopped(lambda: VERIFY.load_verification_plan(self.plan_path, self.size))
        self.plan["writes"].append(dict(self.plan["writes"][0]))
        self.save_plan()
        self.assert_stopped(lambda: VERIFY.load_verification_plan(self.plan_path, self.size))

    def test_traversal_absolute_and_symlink_payload_paths_refuse(self):
        for name in ["../range-00.new", "/tmp/range-00.new", "./range-00.new"]:
            plan = json.loads(json.dumps(self.plan))
            plan["writes"][0]["new_file"] = name
            self.save_plan(plan)
            with self.subTest(name=name):
                self.assert_stopped(lambda: VERIFY.load_verification_plan(self.plan_path, self.size))
        self.save_plan()
        payload = self.plan_dir / "range-00.new"
        payload.unlink()
        payload.symlink_to(self.image)
        self.assert_stopped(lambda: VERIFY.load_verification_plan(self.plan_path, self.size))

    def test_fifo_payload_is_rejected_without_blocking_for_a_writer(self):
        path = self.plan_dir / "range-00.new"
        path.unlink()
        os.mkfifo(path)
        actual_open = VERIFY.os.open
        def guarded_open(path, flags, *args):
            # If this protection regresses, fail the test before blocking.
            self.assertTrue(flags & os.O_NONBLOCK)
            return actual_open(path, flags, *args)
        with mock.patch.object(VERIFY.os, "open", guarded_open):
            self.assert_stopped(lambda: VERIFY.load_verification_plan(self.plan_path, self.size))

    def test_ambiguous_empty_and_inconsistent_partition_relative_plans_refuse(self):
        for change in [{"file": "new-header.bin"}, {"partition_relative_byte": 0}, {"partition_relative_byte": True}]:
            plan = json.loads(json.dumps(self.plan))
            plan["writes"][0].update(change)
            self.save_plan(plan)
            with self.subTest(change=change):
                self.assert_stopped(lambda: VERIFY.load_verification_plan(self.plan_path, self.size))
        self.save_plan({"writes": []})
        self.assert_stopped(lambda: VERIFY.load_verification_plan(self.plan_path, self.size))

    def interrupted_state(self):
        original_chunks = VERIFY.chunks
        def interrupt(path, total, label, start=0):
            if "verify segment 2/" in label:
                raise OSError("synthetic USB dropout")
            yield from original_chunks(path, total, label, start)
        with mock.patch.object(VERIFY, "chunks", interrupt):
            self.assert_stopped(lambda: VERIFY.verify_resume(self.raw, self.size, plan_path=self.plan_path))
        self.assertTrue(self.state.exists())
        return json.loads(self.state.read_text())

    def test_resume_reads_only_unfinished_segments_and_binds_exact_plan(self):
        state = self.interrupted_state()
        self.assertEqual(state["done"], {"0": "ok"})
        seen = []
        original_chunks = VERIFY.chunks
        def record(path, total, label, start=0):
            seen.append(label)
            yield from original_chunks(path, total, label, start)
        with mock.patch.object(VERIFY, "chunks", record):
            VERIFY.verify_resume(self.raw, self.size, plan_path=self.plan_path)
        self.assertFalse(any("verify segment 1/" in label for label in seen))

    def test_changed_plan_metadata_cannot_reuse_progress_even_with_same_crcs(self):
        self.interrupted_state()
        self.plan["source_edited_image"] = "different-locally-reviewed-plan.img"
        self.save_plan()
        self.assert_stopped(lambda: VERIFY.verify_resume(self.raw, self.size, plan_path=self.plan_path))

    def test_changed_payload_and_matching_updated_hashes_cannot_reuse_progress(self):
        self.interrupted_state()
        updated = b"Z" * 512
        (self.plan_dir / "range-00.new").write_bytes(updated)
        self.plan["writes"][0].update(new_sha256=hashlib.sha256(updated).hexdigest(), new_crc32=f"{zlib.crc32(updated):08x}")
        self.save_plan()
        self.raw.write_bytes(self.original[:192 * 512] + updated + self.original[193 * 512:])
        self.assert_stopped(lambda: VERIFY.verify_resume(self.raw, self.size, plan_path=self.plan_path))

    def test_completed_segments_cannot_be_reused_with_a_different_verified_backup(self):
        self.interrupted_state()
        updated = bytearray(self.original)
        updated[-1] ^= 1  # Outside fingerprint and planned ranges.
        self.image.write_bytes(updated)
        self.manifest.write_text(f"{hashlib.sha256(updated).hexdigest()}  original.img\n")
        raw = bytearray(self.raw.read_bytes())
        raw[-1] ^= 1
        self.raw.write_bytes(raw)
        self.assert_stopped(lambda: VERIFY.verify_resume(self.raw, self.size, plan_path=self.plan_path))

    def test_invalid_completed_segment_markers_refuse_instead_of_skipping_reads(self):
        state = self.interrupted_state()
        for done in [{"0": "not checked"}, {"999": "ok"}, []]:
            state["done"] = done
            self.state.write_text(json.dumps(state))
            with self.subTest(done=done):
                self.assert_stopped(lambda: VERIFY.verify_resume(self.raw, self.size, plan_path=self.plan_path))

    def test_other_frame_prefix_and_old_resume_state_refuse(self):
        self.interrupted_state()
        source = self.raw.read_bytes()
        altered = bytearray(source)
        altered[8192 + 1024 + 104] ^= 1  # Synthetic filesystem UUID byte.
        self.raw.write_bytes(altered)
        self.assert_stopped(lambda: VERIFY.verify_resume(self.raw, self.size, plan_path=self.plan_path))
        self.raw.write_bytes(source)
        self.state.write_text(json.dumps({"kind": "verify", "size": self.size, "done": {"0": "ok"}, "plan": {}}))
        self.assert_stopped(lambda: VERIFY.verify_resume(self.raw, self.size, plan_path=self.plan_path))

    def test_plan_range_inside_fingerprint_is_compared_with_expected_patched_bytes(self):
        self.plan = self.write_data_plan(sector=24)
        VERIFY.verify_resume(self.raw, self.size, plan_path=self.plan_path)

    def test_original_verification_ignores_patch_plan_and_checks_every_original_byte(self):
        self.raw.write_bytes(self.original)
        self.plan_path.write_text("not a plan")
        VERIFY.verify_original(self.raw, self.size)
        VERIFY.verify_original_resume(self.raw, self.size)

    def test_apply_patches_handles_chunk_and_segment_boundaries_exactly(self):
        source = b"O" * 32
        patches = [(12, b"N" * 12)]
        first = VERIFY.apply_patches(source[:16], 0, patches)
        second = VERIFY.apply_patches(source[16:], 16, patches)
        self.assertEqual(first + second, b"O" * 12 + b"N" * 12 + b"O" * 8)

    def test_cli_accepts_explicit_plan_only_for_patched_verification(self):
        with mock.patch.object(VERIFY.os, "geteuid", return_value=0), mock.patch.object(VERIFY, "open_disk", return_value="synthetic") as open_disk:
            action = mock.Mock()
            with mock.patch.dict(VERIFY.ACTIONS, {"verify-resume": action}), mock.patch.object(sys, "argv", [str(SCRIPT), "verify-resume", "disk7", str(self.size), "--plan", str(self.plan_path)]):
                VERIFY.main()
            action.assert_called_once_with("synthetic", self.size, plan_path=self.plan_path)
            open_disk.assert_called_once_with("disk7", self.size)
            open_disk.reset_mock()
            for mode in ["backup", "backup-resume", "verify-original", "verify-original-resume"]:
                with self.subTest(mode=mode), mock.patch.object(sys, "argv", [str(SCRIPT), mode, "disk7", str(self.size), "--plan", str(self.plan_path)]):
                    self.assert_stopped(VERIFY.main)
            open_disk.assert_not_called()


if __name__ == "__main__":
    unittest.main()
