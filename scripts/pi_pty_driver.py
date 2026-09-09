#!/usr/bin/env python3
import json
import os
import pty
import select
import signal
import subprocess
import sys
import time


def kill_process_group(proc: subprocess.Popen[bytes], sig: int) -> None:
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        return
    except PermissionError:
        return


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: pi_pty_driver.py <spec-json>", file=sys.stderr)
        return 2

    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        spec = json.load(fh)

    env = os.environ.copy()
    env.update(spec.get("env", {}))
    master, slave = pty.openpty()
    proc = subprocess.Popen(
        spec["argv"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        cwd=spec["cwd"],
        env=env,
        close_fds=True,
        text=False,
        start_new_session=True,
    )
    os.close(slave)

    transcript = bytearray()
    outcome = {
        "driverExitCode": 0,
        "processExitCode": None,
        "timedOut": False,
        "failedExpectation": None,
        "elapsedMs": 0,
        "output": "",
    }

    def decoded() -> str:
        return transcript.decode("utf-8", "replace")

    def finalize_process():
        try:
            return proc.wait(timeout=1.5)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except ProcessLookupError:
                return proc.poll()
            try:
                return proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                return proc.poll()

    def pump(until: float) -> None:
        while time.time() < until:
            timeout = max(0.0, min(0.2, until - time.time()))
            readable, _, _ = select.select([master], [], [], timeout)
            if master in readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    return
                if not chunk:
                    return
                transcript.extend(chunk)
            if proc.poll() is not None:
                return

    started = time.time()
    try:
        for step in spec.get("steps", []):
            pump(time.time() + step.get("waitBeforeMs", 0) / 1000.0)
            os.write(master, step["input"].encode("utf-8"))
            expected = step.get("expect")
            if expected:
                deadline = time.time() + step.get("timeoutMs", 5000) / 1000.0
                matched = False
                while time.time() < deadline:
                    pump(time.time() + 0.2)
                    if expected in decoded():
                        matched = True
                        break
                    if proc.poll() is not None:
                        break
                if not matched:
                    outcome["driverExitCode"] = 1
                    outcome["failedExpectation"] = expected
                    break

        # Bounded relative to `started`, not "now" — otherwise a step whose
        # `expect` never matches (which already consumed up to its own
        # timeoutMs) would grant the trailing wait-for-exit a fresh full
        # budget on top, letting total runtime blow past the caller's
        # declared timeoutMs and get killed externally with no JSON output.
        deadline = started + spec.get("timeoutMs", 10000) / 1000.0
        while time.time() < deadline and proc.poll() is None:
            pump(time.time() + 0.2)
        if proc.poll() is None:
            outcome["timedOut"] = True
            outcome["driverExitCode"] = 1
            kill_process_group(proc, signal.SIGTERM)
            time.sleep(0.5)
            if proc.poll() is None:
                kill_process_group(proc, signal.SIGKILL)
        outcome["processExitCode"] = finalize_process()
        if outcome["processExitCode"] != 0:
            outcome["driverExitCode"] = 1
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        outcome["elapsedMs"] = int((time.time() - started) * 1000)
        outcome["output"] = decoded()
        json.dump(outcome, sys.stdout)

    return int(outcome["driverExitCode"])


if __name__ == "__main__":
    sys.exit(main())
