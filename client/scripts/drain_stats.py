#!/usr/bin/env python3
"""
Lock-aware drain tool for claude-stats-hook v4 buffer.

Why this exists: the v4 stats hook has a 10s send budget per run, so it can
never catch up once the backlog grows. A manual drain is the only practical
recovery — but naive drainers race the hook, which reloads and rewrites the
buffer on every Stop event and clobbers the drainer's progress.

This tool coordinates with the hook by acquiring the hook's own lock
(e.g. ~/.claude/stats.lock) and refreshing the timestamp periodically so the
hook fast-fails its acquire() during the drain.

Usage:
    python3 drain_stats.py                    # drain ~/.claude buffer (default)
    python3 drain_stats.py --backend claude-mm # drain ~/.claude-mm buffer
    python3 drain_stats.py --backend claude-glm # drain ~/.claude-glm buffer
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

BATCH = 200
REQUEST_TIMEOUT = 30  # server is slow; 15s caused HTTP 000 failures
LOCK_REFRESH_INTERVAL = 3.0  # hook's LOCK_STALE_TIME is 10s
MAX_FAIL_BATCHES = 20


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse_args() -> tuple[Path, Path, Path, Path]:
    parser = argparse.ArgumentParser(
        description="Drain claude-stats-hook buffer with lock coordination."
    )
    parser.add_argument(
        "--backend",
        default="claude",
        choices=["claude", "claude-mm", "claude-glm"],
        help="Backend name (determines config dir). Default: claude",
    )
    args = parser.parse_args()

    backend_dir = Path.home() / f".{args.backend}" if args.backend != "claude" else Path.home() / ".claude"
    buffer = backend_dir / "stats-state.buffer.json"
    lock = backend_dir / "stats.lock"
    config = backend_dir / "stats-config.json"
    return backend_dir, buffer, lock, config


def main() -> int:
    backend_dir, BUFFER, LOCK, CONFIG = parse_args()

    if not BUFFER.exists():
        print(f"No buffer at {BUFFER}; nothing to drain.")
        return 0

    cfg = json.loads(CONFIG.read_text())
    username = cfg["username"]
    server_url = cfg["serverUrl"].rstrip("/") + "/api/usage/submit"

    print(f"[{backend_dir.name}] Acquiring hook lock at {LOCK} ...")

    # --- lock acquisition (mirrors hook's FileLock.acquire) ---
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if LOCK.exists():
            try:
                data = json.loads(LOCK.read_text())
                ts = datetime.fromisoformat(data["timestamp"].replace("Z", "+00:00"))
                age_ms = (datetime.now(timezone.utc) - ts).total_seconds() * 1000
                stale = age_ms > 10_000
            except Exception:
                stale = True
            if stale:
                try:
                    LOCK.unlink()
                except FileNotFoundError:
                    pass
            else:
                time.sleep(0.05)
                continue
        try:
            fd = os.open(str(LOCK), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            os.write(fd, json.dumps({"pid": os.getpid(), "timestamp": _iso_now()}).encode())
            os.close(fd)
            break
        except FileExistsError:
            time.sleep(0.05)
    else:
        print(f"ERROR: could not acquire lock within 5s. "
              f"Is a hook run stuck? Delete {LOCK} manually.", file=sys.stderr)
        return 2

    # --- lock refresher (keeps lock alive during drain) ---
    def refresh_lock() -> None:
        while True:
            time.sleep(LOCK_REFRESH_INTERVAL)
            try:
                fd = os.open(str(LOCK), os.O_WRONLY | os.O_TRUNC)
                os.write(fd, json.dumps({"pid": os.getpid(), "timestamp": _iso_now()}).encode())
                os.close(fd)
            except Exception:
                pass

    refresher = threading.Thread(target=refresh_lock, daemon=True)
    refresher.start()

    def cleanup(*_) -> None:
        try:
            LOCK.unlink()
        except FileNotFoundError:
            pass
        sys.exit(130)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    # --- drain ---
    entries = json.loads(BUFFER.read_text())["pendingEntries"]
    total = len(entries)
    print(f"[{backend_dir.name}] Draining {total} entries to {server_url}")

    sent = 0
    failed = 0
    t0 = time.time()

    for i in range(0, total, BATCH):
        batch = entries[i : i + BATCH]
        payload = json.dumps({"username": username, "usage": batch})
        try:
            r = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                 "-X", "POST", server_url,
                 "-H", "Content-Type: application/json",
                 "-H", "User-Agent: claude-stats-drain/1.0",
                 "--max-time", str(REQUEST_TIMEOUT),
                 "-d", "@-"],
                input=payload, capture_output=True, text=True,
                timeout=REQUEST_TIMEOUT + 5,
            )
            code = r.stdout.strip()
        except subprocess.TimeoutExpired:
            code = "TIMEOUT"
        except Exception as e:
            code = f"ERR:{e}"

        if code == "200":
            sent += len(batch)
        else:
            failed += 1
            print(f"[{backend_dir.name}] batch failed: HTTP {code}", file=sys.stderr)
            if failed >= MAX_FAIL_BATCHES:
                print(f"[{backend_dir.name}] Too many failures ({failed}); aborting.", file=sys.stderr)
                break

        if (i // BATCH) % 20 == 0:
            elapsed = time.time() - t0
            rate = sent / elapsed if elapsed else 0
            pct = 100 * sent // total if total else 0
            print(f"[{backend_dir.name}] sent={sent}/{total} ({pct}%) "
                  f"elapsed={elapsed:.0f}s rate={rate:.0f}/s failed={failed}", flush=True)

    # --- cleanup ---
    remaining = entries[sent:]
    if not remaining:
        BUFFER.unlink()
        print(f"[{backend_dir.name}] Buffer cleared.")
    else:
        BUFFER.write_text(json.dumps({"pendingEntries": remaining, "lastAttempt": _iso_now()}))
        print(f"[{backend_dir.name}] Remaining in buffer: {len(remaining)}")

    print(f"[{backend_dir.name}] DONE sent={sent}/{total} failed_batches={failed} "
          f"duration={time.time() - t0:.0f}s")

    try:
        LOCK.unlink()
    except FileNotFoundError:
        pass

    return 0 if failed < MAX_FAIL_BATCHES else 1


if __name__ == "__main__":
    sys.exit(main())
