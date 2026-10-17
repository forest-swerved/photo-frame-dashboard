#!/usr/bin/env python3
"""Back up and verify the PF1007L eMMC through the read-only U-Boot `ums` disk (macOS or Linux).

Usage (run from the repository root, with sudo):
  sudo python3 -I scripts/a33-uboot/emmc-macos.py backup diskN <exact-bytes>
  sudo python3 -I scripts/a33-uboot/emmc-macos.py verify diskN <exact-bytes>
  sudo python3 -I scripts/a33-uboot/emmc-macos.py verify-original diskN <exact-bytes>
  sudo python3 -I scripts/a33-uboot/emmc-macos.py backup-resume diskN <exact-bytes>
  sudo python3 -I scripts/a33-uboot/emmc-macos.py verify-resume diskN <exact-bytes>
  sudo python3 -I scripts/a33-uboot/emmc-macos.py verify-original-resume diskN <exact-bytes>
  sudo python3 -I scripts/a33-uboot/emmc-macos.py verify diskN <exact-bytes> --plan <plan.json>
  sudo python3 -I scripts/a33-uboot/emmc-macos.py verify-resume diskN <exact-bytes> --plan <plan.json>

<exact-bytes> is the eMMC size from `diskutil info diskN` (Disk Size, in bytes); on Linux
pass the whole disk (e.g. sdb) and its size from `lsblk -b`. It
guards against a disk number that changed after a replug. Both modes refuse a disk
that macOS reports as writable: only the read-only U-Boot build should be running.

backup  reads the whole disk to backups/a33-emmc-full.img, re-reads it independently,
        rejects 0xCC filler, gzips it and verifies the gzip readback.
verify  every byte must equal that backup, except the exact ranges in the plan,
        which must equal its validated patched payloads. The default plan is
        diagnostics/a33-boot-patch/plan.json; --plan also accepts data-patch plans.
verify-original
        after restore-boot: every byte must equal the backup.
backup-resume, verify-resume, verify-original-resume
        the same checks in 1 GiB segments, with progress saved after each segment. Use these
        when the frame drops off USB partway (seen through bus-powered hubs): power-cycle the
        frame into FEL, load U-Boot again, and rerun the same command to continue. Each backup
        segment is read twice from the disk and once back from the image file, and all three
        must match. On resume, the disk must have the same fingerprint (first 4 MiB plus the
        start of the first partition, which is unique per unit) as when the run started.
        On Linux the page cache is dropped around every read, so re-reads come from the eMMC.
        verify-resume binds progress to the exact plan/payloads, verified backup,
        and expected frame fingerprint. It refuses old or different saved runs.
"""

import gzip
import hashlib
import json
import os
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BACKUPS = REPO / "backups"
IMAGE = BACKUPS / "a33-emmc-full.img"
PARTIAL = BACKUPS / "a33-emmc-full.img.partial"
GZIP_PATH = BACKUPS / "a33-emmc-full.img.gz"
PLAN = REPO / "diagnostics/a33-boot-patch/plan.json"
SECTOR = 512
CHUNK = 4 * 1024 * 1024
FILLER_RUN = 4096
SEGMENT = 1024 * 1024 * 1024
STATE = BACKUPS / "a33-emmc-resume.json"
VERIFY_STATE = BACKUPS / "a33-emmc-verify-resume.json"
ORIGINAL_VERIFY_STATE = BACKUPS / "a33-emmc-verify-original-resume.json"


def fail(message):
    sys.exit(f"STOP: {message}")


def open_disk_linux(identifier, expected_size):
    if not re.fullmatch(r"sd[a-z]+", identifier):
        fail("pass a whole disk like sdb, not a partition")
    sys_block = Path("/sys/block") / identifier
    model = (sys_block / "device/model").read_text().strip()
    if not re.fullmatch(r"UMS disk \d+", model):
        fail(f"unexpected model {model!r}; expected U-Boot's 'UMS disk N'")
    size = int((sys_block / "size").read_text()) * SECTOR
    if size != expected_size:
        fail(f"size {size} != expected {expected_size}")
    if "/usb" not in str(sys_block.resolve()):
        fail("not a USB disk")
    if (sys_block / "ro").read_text().strip() != "1":
        fail("disk is writable; the read-only U-Boot build is not the one running")
    if re.search(rf"^/dev/{identifier}\d* ", Path("/proc/mounts").read_text(), re.M):
        fail(f"unmount every partition of {identifier} first")
    return f"/dev/{identifier}"


def open_disk(identifier, expected_size):
    if sys.platform == "linux":
        return open_disk_linux(identifier, expected_size)
    if not re.fullmatch(r"disk\d+", identifier):
        fail("pass a whole disk like disk4, not a partition")
    info = plistlib.loads(subprocess.check_output(["diskutil", "info", "-plist", identifier]))
    if not re.fullmatch(r"UMS disk \d+", info.get("MediaName", "")):
        fail(f"unexpected media name {info.get('MediaName')!r}; expected U-Boot's 'UMS disk N'")
    if info.get("TotalSize") != expected_size:
        fail(f"size {info.get('TotalSize')} != expected {expected_size}")
    if info.get("Internal", True) or info.get("BusProtocol") != "USB":
        fail("not an external USB disk")
    if info.get("WritableMedia", True):
        fail("disk is writable; the read-only U-Boot build is not the one running")
    subprocess.check_call(["diskutil", "unmountDisk", identifier])
    return f"/dev/r{identifier}"


def drop_cache(fd, start=0, length=0):
    """Linux keeps block-device reads in the page cache. Drop them so a second pass really
    re-reads the eMMC instead of memory. macOS uses the uncached /dev/rdiskN instead."""
    if sys.platform == "linux":
        os.posix_fadvise(fd, start, length, os.POSIX_FADV_DONTNEED)


def chunks(path, total, label, start=0):
    done, started = 0, time.time()
    with open(path, "rb", buffering=0) as source:
        drop_cache(source.fileno())
        source.seek(start)
        while done < total:
            block = source.read(min(CHUNK, total - done))
            if not block:
                fail(f"short read at byte {done}")
            drop_cache(source.fileno(), start + done, len(block))
            yield start + done, block
            done += len(block)
            rate = done / max(time.time() - started, 0.001) / 1e6
            print(f"\r  {label}: {done * 100 // total:3d}%  {rate:5.1f} MB/s", end="", flush=True)
    print()


def backup(raw_path, size):
    for path in (PARTIAL, IMAGE, GZIP_PATH):
        if path.exists():
            fail(f"{path.name} already exists; refusing to overwrite")
    BACKUPS.mkdir(exist_ok=True)
    os.umask(0o077)

    first, filler = hashlib.sha256(), 0
    with open(PARTIAL, "xb") as out:
        for _, block in chunks(raw_path, size, "pass 1 (copy)"):
            first.update(block)
            out.write(block)
            filler += block.count(b"\xcc" * FILLER_RUN)
    print(f"  pass 1 SHA-256: {first.hexdigest()}  (0xCC runs: {filler})")
    if filler:
        fail("0xCC filler found; this may not be real flash data")

    second = hashlib.sha256()
    for _, block in chunks(raw_path, size, "pass 2 (re-read)"):
        second.update(block)
    if second.hexdigest() != first.hexdigest():
        fail("independent re-read differs")

    stored = hashlib.sha256()
    for _, block in chunks(PARTIAL, size, "image file"):
        stored.update(block)
    if stored.hexdigest() != first.hexdigest():
        fail("image file differs from the disk")

    print("  compressing...")
    with open(PARTIAL, "rb") as source, gzip.open(GZIP_PATH, "xb", compresslevel=6) as target:
        shutil.copyfileobj(source, target, CHUNK)
    readback = hashlib.sha256()
    with gzip.open(GZIP_PATH, "rb") as handle:
        for block in iter(lambda: handle.read(CHUNK), b""):
            readback.update(block)
    if readback.hexdigest() != first.hexdigest():
        fail("gzip readback differs")

    PARTIAL.rename(IMAGE)
    (BACKUPS / "a33-emmc-full.sha256").write_text(f"{first.hexdigest()}  {IMAGE.name}\n")
    print(f"Verified full eMMC backup: {IMAGE} ({size} bytes), SHA-256 {first.hexdigest()}")


def verify_original(raw_path, size):
    verify(raw_path, size, patched=False)


def verified_backup(size):
    """Verify the finished host backup before allowing it to define expected bytes."""
    before = IMAGE.stat()
    if before.st_size != size:
        fail("backup image size differs from the disk")
    if not stat.S_ISREG(before.st_mode):
        fail("backup is not a regular host file")
    expected = backup_hash()
    digest = hashlib.sha256()
    with open(IMAGE, "rb") as source:
        if backup_file_identity(os.fstat(source.fileno())) != backup_file_identity(before):
            fail("backup path changed before hashing")
        for block in iter(lambda: source.read(CHUNK), b""):
            digest.update(block)
        descriptor_after = os.fstat(source.fileno())
    after = IMAGE.stat()
    if (backup_file_identity(before) != backup_file_identity(after)
            or backup_file_identity(before) != backup_file_identity(descriptor_after)
            or digest.hexdigest() != expected):
        fail("finished backup differs from its recorded SHA-256 or changed while being read")
    return {"sha256": expected, "size": size, "file_identity": backup_file_identity(after)}


def backup_file_identity(info):
    return {"device": info.st_dev, "inode": info.st_ino, "size": info.st_size,
            "mtime_ns": info.st_mtime_ns, "ctime_ns": info.st_ctime_ns}


def require_unchanged_backup(identity, descriptor=None):
    """Keep comparisons bound to the same hashed file through final publication."""
    try:
        if backup_file_identity(IMAGE.stat()) != identity["file_identity"]:
            fail("backup changed after SHA-256 validation")
        if descriptor is not None and backup_file_identity(os.fstat(descriptor.fileno())) != identity["file_identity"]:
            fail("open backup file differs from the validated source")
    except OSError:
        fail("validated backup is no longer available")


def load_verification_plan(plan_path, size):
    """Validate either repository plan schema, including its original backup bytes.

    Payloads must be regular files directly beside the plan, never symlinks or
    traversal paths. Plan identity binds exact JSON metadata plus payload SHA-256,
    so changing ranges/files with unchanged CRC metadata cannot reuse progress.
    """
    plan_path = Path(plan_path)
    try:
        if not plan_path.is_file() or plan_path.stat().st_size > 1024 * 1024:
            fail("plan must be a regular JSON file of at most 1 MiB")
        plan = json.loads(plan_path.read_text())
    except (OSError, ValueError):
        fail("could not read a valid patch plan")
    writes = plan.get("writes") if isinstance(plan, dict) else None
    if not isinstance(writes, list) or not 1 <= len(writes) <= 64:
        fail("plan needs between 1 and 64 patch ranges")
    root = plan_path.resolve().parent
    patches, hashes = [], []
    total = 0

    def payload(name, length):
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name):
            fail("payload name must be a plain filename beside the plan")
        path = root / name
        try:
            # Nonblocking open lets fstat reject FIFOs/devices without waiting
            # for a writer before the regular-file guard can run.
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
            with os.fdopen(fd, "rb") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size != length:
                    fail("payload is not a regular file of the exact planned size")
                data = source.read(length + 1)
        except OSError:
            fail("payload could not be opened safely")
        if len(data) != length:
            fail("payload changed size while being read")
        return data

    def digest_match(data, supplied, algorithm):
        if algorithm == "sha256":
            actual = hashlib.sha256(data).hexdigest()
            expression = r"[0-9a-f]{64}"
        else:
            actual = f"{zlib.crc32(data):08x}"
            expression = r"[0-9a-f]{8}"
        if not isinstance(supplied, str) or not re.fullmatch(expression, supplied) or supplied != actual:
            fail(f"payload {algorithm} does not match the plan")

    with open(IMAGE, "rb") as backup_file:
        for write in writes:
            if not isinstance(write, dict):
                fail("invalid patch range")
            sector, sectors = write.get("sector"), write.get("sectors")
            if type(sector) is not int or type(sectors) is not int or sector < 0 or sectors <= 0:
                fail("patch range needs nonnegative integer sector and positive sector count")
            start, length = sector * SECTOR, sectors * SECTOR
            if start + length > size or length > 16 * 1024 * 1024:
                fail("patch range is outside the disk or exceeds its 16 MiB payload limit")
            total += length
            if total > 32 * 1024 * 1024:
                fail("planned payloads exceed 32 MiB")
            if "new_file" in write:
                if "file" in write or write.get("length") != length:
                    fail("ambiguous data-patch schema or incorrect byte length")
                original = payload(write.get("orig_file"), length)
                new = payload(write.get("new_file"), length)
                for kind, data in (("orig", original), ("new", new)):
                    digest_match(data, write.get(f"{kind}_sha256"), "sha256")
                    digest_match(data, write.get(f"{kind}_crc32"), "crc32")
                relative = write.get("partition_relative_byte")
                partition_start = plan.get("partition_start_sector")
                if (type(relative) is not int or relative < 0 or relative % SECTOR
                        or type(partition_start) is not int or partition_start < 0
                        or partition_start * SECTOR + relative != start):
                    fail("data-patch partition-relative range does not match its absolute sector")
            else:
                name = write.get("file")
                if name not in ("new-header.bin", "new-ramdisk.bin") or not isinstance(plan.get("crc32"), dict):
                    fail("unsupported boot-patch payload schema")
                part = name[4:-4]
                original = payload(f"orig-{part}.bin", length)
                new = payload(name, length)
                digest_match(original, plan["crc32"].get(f"orig_{part}"), "crc32")
                digest_match(new, plan["crc32"].get(f"new_{part}"), "crc32")
            if new == original:
                fail("patch range does not change any bytes")
            backup_file.seek(start)
            if backup_file.read(length) != original:
                fail("original payload differs from the same range of the verified backup")
            patches.append((start, new))
            hashes.append({"sector": sector, "sectors": sectors,
                           "original_sha256": hashlib.sha256(original).hexdigest(),
                           "new_sha256": hashlib.sha256(new).hexdigest()})
    patches.sort(key=lambda patch: patch[0])
    if any(a + len(data) > b for (a, data), (b, _) in zip(patches, patches[1:])):
        fail("patch ranges overlap")
    identity = hashlib.sha256(json.dumps({"plan": plan, "payloads": hashes},
                                       sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return patches, identity


def apply_patches(original, offset, patches):
    want = bytearray(original)
    for start, data in patches:
        lo, hi = max(start, offset), min(start + len(data), offset + len(want))
        if lo < hi:
            want[lo - offset:hi - offset] = data[lo - start:hi - start]
    return want


def verify(raw_path, size, patched=True, plan_path=None):
    backup_identity = verified_backup(size)
    patches, _ = load_verification_plan(plan_path or PLAN, size) if patched else ([], None)

    mismatches = []
    with open(IMAGE, "rb") as backup_file:
        require_unchanged_backup(backup_identity, backup_file)
        for offset, got in chunks(raw_path, size, "verify"):
            require_unchanged_backup(backup_identity, backup_file)
            original = backup_file.read(len(got))
            require_unchanged_backup(backup_identity, backup_file)
            if len(original) != len(got):
                fail("backup file became truncated during verification")
            want = apply_patches(original, offset, patches)
            if got != want:
                mismatches.append(offset)
                if len(mismatches) > 10:
                    break
    if mismatches:
        fail(f"mismatch in 4 MiB chunks at byte offsets {mismatches}")
    require_unchanged_backup(backup_identity)
    if patched:
        print("Verified: the eMMC equals the backup plus exactly the validated patch plan.")
    else:
        print("Verified: the eMMC equals the original backup.")


def segments(size):
    return [(i, i * SEGMENT, min(SEGMENT, size - i * SEGMENT)) for i in range((size + SEGMENT - 1) // SEGMENT)]


def load_state(path, size, kind):
    if not path.exists():
        return {"kind": kind, "size": size, "done": {}}
    state = json.loads(path.read_text())
    if state.get("kind") != kind or state.get("size") != size:
        fail(f"{path.name} is for a different disk size or mode")
    return state


def save_state(path, state):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    os.replace(tmp, path)


def fingerprint(raw_path):
    """SHA-256 of the first 4 MiB plus 64 KiB at the start of the first MBR partition.

    The first 4 MiB (MBR, boot0) is the same on every unit with the same firmware. The first
    partition is UDISK (/data); its ext4 superblock holds a filesystem UUID that differs per
    unit, so the fingerprint tells two frames apart. Booting Android between runs changes the
    superblock, so the fingerprint then no longer matches and the run must start over.
    """
    with open(raw_path, "rb", buffering=0) as disk:
        drop_cache(disk.fileno())
        head = disk.read(CHUNK)
        if len(head) != CHUNK or head[510:512] != b"\x55\xaa":
            fail("no MBR at the start of the disk")
        first = struct.unpack_from("<I", head, 446 + 8)[0]
        if not head[446 + 4] or not first:
            fail("the first MBR partition is empty")
        disk.seek(first * SECTOR)
        part = disk.read(64 * 1024)
        if len(part) != 64 * 1024:
            fail("short read of the first partition fingerprint")
    return hashlib.sha256(head + part).hexdigest()


def backup_hash():
    path = BACKUPS / "a33-emmc-full.sha256"
    if not path.exists():
        fail(f"{path.name} is missing; verify needs the finished backup")
    values = path.read_text().split()
    if not values or not re.fullmatch(r"[0-9a-f]{64}", values[0]):
        fail("finished backup SHA-256 file is invalid")
    return values[0]


def run_segments(state_path, state, size, work, label):
    todo = [seg for seg in segments(size) if str(seg[0]) not in state["done"]]
    print(f"  {len(segments(size)) - len(todo)} of {len(segments(size))} segments already done")
    for index, start, length in todo:
        try:
            state["done"][str(index)] = work(index, start, length)
        except OSError as error:
            save_state(state_path, state)
            fail(f"{error} during segment {index} ({label}). Progress is saved. Power-cycle the frame "
                 f"into FEL, load U-Boot again, then rerun the same command to continue.")
        save_state(state_path, state)


def backup_resume(raw_path, size):
    for path in (IMAGE, GZIP_PATH):
        if path.exists():
            fail(f"{path.name} already exists; refusing to overwrite")
    BACKUPS.mkdir(exist_ok=True)
    os.umask(0o077)
    disk_id = fingerprint(raw_path)
    if STATE.exists():
        state = load_state(STATE, size, "backup")
        if not PARTIAL.exists():
            fail(f"{STATE.name} exists but {PARTIAL.name} is missing")
        if state.get("fingerprint") != disk_id:
            fail("this disk is not the one the saved run started on (different frame, or Android "
                 f"booted in between). Move {STATE.name} and {PARTIAL.name} aside to start over.")
    elif PARTIAL.exists():
        fail(f"{PARTIAL.name} exists without resume state (left by a plain backup?); remove it first")
    else:
        state = {"kind": "backup", "size": size, "done": {}, "fingerprint": disk_id}
        with open(PARTIAL, "xb") as out:
            out.truncate(size)
        save_state(STATE, state)

    def work(index, start, length):
        name = f"segment {index + 1}/{len(segments(size))}"
        first, filler = hashlib.sha256(), 0
        with open(PARTIAL, "r+b") as out:
            out.seek(start)
            for _, block in chunks(raw_path, length, f"{name} pass 1", start):
                first.update(block)
                out.write(block)
                filler += block.count(b"\xcc" * FILLER_RUN)
            out.flush()
            os.fsync(out.fileno())
        if filler:
            fail(f"0xCC filler found in {name}; this may not be real flash data")
        second = hashlib.sha256()
        for _, block in chunks(raw_path, length, f"{name} pass 2", start):
            second.update(block)
        stored = hashlib.sha256()
        for _, block in chunks(PARTIAL, length, f"{name} image file", start):
            stored.update(block)
        if not first.hexdigest() == second.hexdigest() == stored.hexdigest():
            state["done"].pop(str(index), None)
            fail(f"{name}: disk passes or image file differ; not marked done")
        return first.hexdigest()

    run_segments(STATE, state, size, work, "backup")

    whole = hashlib.sha256()
    for index, start, length in segments(size):
        part = hashlib.sha256()
        for _, block in chunks(PARTIAL, length, f"image file segment {index + 1}", start):
            part.update(block)
            whole.update(block)
        if part.hexdigest() != state["done"].get(str(index)):
            fail(f"image file segment {index + 1} differs from the hash saved when it was read")
    print("  compressing...")
    with open(PARTIAL, "rb") as source, gzip.open(GZIP_PATH, "xb", compresslevel=6) as target:
        shutil.copyfileobj(source, target, CHUNK)
    readback = hashlib.sha256()
    with gzip.open(GZIP_PATH, "rb") as handle:
        for block in iter(lambda: handle.read(CHUNK), b""):
            readback.update(block)
    if readback.hexdigest() != whole.hexdigest():
        fail("gzip readback differs")
    PARTIAL.rename(IMAGE)
    (BACKUPS / "a33-emmc-full.sha256").write_text(f"{whole.hexdigest()}  {IMAGE.name}\n")
    STATE.rename(STATE.with_suffix(".done.json"))
    print(f"Verified full eMMC backup: {IMAGE} ({size} bytes), SHA-256 {whole.hexdigest()}")
    print(f"  {len(segments(size))} segments, each read twice from the disk and once from the file.")


def expected_fingerprint(patches):
    """Expected prefix/partition fingerprint after applying only the explicit plan."""
    with open(IMAGE, "rb") as image:
        head = image.read(CHUNK)
        if len(head) != CHUNK or head[510:512] != b"\x55\xaa":
            fail("backup has no complete MBR fingerprint")
        first = struct.unpack_from("<I", head, 446 + 8)[0]
        if not head[446 + 4] or not first:
            fail("the backup's first MBR partition is empty")
        image.seek(first * SECTOR)
        part = image.read(64 * 1024)
        if len(part) != 64 * 1024:
            fail("backup's first partition fingerprint is truncated")
    return hashlib.sha256(apply_patches(head, 0, patches)
                          + apply_patches(part, first * SECTOR, patches)).hexdigest()


def verify_resume(raw_path, size, patched=True, plan_path=None):
    backup_identity = verified_backup(size)
    patches, plan_identity = load_verification_plan(plan_path or PLAN, size) if patched else ([], None)
    state_path, kind = (VERIFY_STATE, "verify") if patched else (ORIGINAL_VERIFY_STATE, "verify-original")
    disk_identity = fingerprint(raw_path)
    if disk_identity != expected_fingerprint(patches):
        fail("disk fingerprint differs from the verified backup plus plan (different frame or unexpected changes)")
    existed = state_path.exists()
    state = load_state(state_path, size, kind)
    required = {"verification_version": 2, "plan_identity": plan_identity,
                "backup_identity": backup_identity, "fingerprint": disk_identity}
    for key, value in required.items():
        if existed and state.get(key) != value:
            fail(f"{state_path.name} belongs to an old/different plan, backup or frame; move it aside to start over")
        state[key] = value
    valid_segments = {str(index) for index, _, _ in segments(size)}
    if not isinstance(state.get("done"), dict) or any(
            key not in valid_segments or value != "ok" for key, value in state["done"].items()):
        fail("verification resume state has invalid completed segments")

    def work(index, start, length):
        with open(IMAGE, "rb") as backup_file:
            require_unchanged_backup(backup_identity, backup_file)
            backup_file.seek(start)
            for offset, got in chunks(raw_path, length, f"verify segment {index + 1}/{len(segments(size))}", start):
                require_unchanged_backup(backup_identity, backup_file)
                original = backup_file.read(len(got))
                require_unchanged_backup(backup_identity, backup_file)
                if len(original) != len(got):
                    fail("backup file became truncated during verification")
                want = apply_patches(original, offset, patches)
                if got != want:
                    fail(f"mismatch in the 4 MiB chunk at byte offset {offset}")
            require_unchanged_backup(backup_identity, backup_file)
        return "ok"

    run_segments(state_path, state, size, work, kind)
    require_unchanged_backup(backup_identity)
    state_path.rename(state_path.with_suffix(".done.json"))
    if patched:
        print("Verified: the eMMC equals the backup plus exactly the validated patch plan.")
    else:
        print("Verified: the eMMC equals the original backup.")


def verify_original_resume(raw_path, size):
    verify_resume(raw_path, size, patched=False)


ACTIONS = {"backup": backup, "verify": verify, "verify-original": verify_original,
           "backup-resume": backup_resume, "verify-resume": verify_resume,
           "verify-original-resume": verify_original_resume}


def main():
    if len(sys.argv) not in (4, 6) or sys.argv[1] not in ACTIONS:
        sys.exit(__doc__)
    action, identifier = sys.argv[1], sys.argv[2]
    plan_path = None
    if len(sys.argv) == 6:
        if action not in ("verify", "verify-resume") or sys.argv[4] != "--plan":
            fail("--plan is supported only for verify and verify-resume")
        plan_path = Path(sys.argv[5])
    if os.geteuid() != 0:
        fail("run with sudo")
    try:
        size = int(sys.argv[3])
    except ValueError:
        fail("exact byte size must be an integer")
    if size <= 0 or size % SECTOR:
        fail("exact byte size must be positive and sector-aligned")
    raw_path = open_disk(identifier, size)
    if plan_path is not None:
        ACTIONS[action](raw_path, size, plan_path=plan_path)
    else:
        ACTIONS[action](raw_path, size)


if __name__ == "__main__":
    main()
