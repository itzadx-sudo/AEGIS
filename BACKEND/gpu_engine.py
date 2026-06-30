"""
gpu_engine.py — app-managed lifecycle for the GPU inference engines.

The CLI calls `ensure_started()` before any command that needs the LLM or the
embedding model. It launches run_gpu.sh (which starts the two llama_cpp.server
instances on the GPU), waits until both are serving, and registers an atexit /
signal handler so the servers are shut down when the process exits.

Idempotent + polite:
  • If both ports are already healthy (e.g. you ran `start-gpu-engine`
    manually, or a previous call already started them), we reuse them and do
    NOT register a teardown — we only stop what we started.
  • run_gpu.sh is itself idempotent per-port, so if only the LLM is up it will
    start just the embedding server; we then only own/stop that one via the
    process group.
"""

import os
import time
import signal
import atexit
import subprocess
import urllib.request

import config

_RUN_GPU_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "run_gpu.sh")

_proc: subprocess.Popen | None = None   # the run_gpu.sh process (session leader)
_managed = False                        # True only if we launched something


def _port_healthy(port: int, timeout: float = 1.0) -> bool:
    url = f"http://localhost:{port}/v1/models"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _both_up() -> bool:
    return _port_healthy(config.LLM_SERVER_PORT) and _port_healthy(config.EMBED_SERVER_PORT)


def ensure_started(wait_timeout: int = 180) -> None:
    """Make sure both GPU servers are serving. Starts them if needed."""
    global _proc, _managed

    if _both_up():
        print("↺ GPU engines already running — reusing.")
        return

    if not os.path.exists(_RUN_GPU_SH):
        raise FileNotFoundError(f"run_gpu.sh not found at {_RUN_GPU_SH}")

    print("▶ Starting GPU engines via run_gpu.sh …")
    # New session so we can signal the whole process group (run_gpu.sh + its
    # llama_cpp.server children) on shutdown.
    _proc = subprocess.Popen(
        ["bash", _RUN_GPU_SH],
        cwd=os.path.dirname(_RUN_GPU_SH),
        start_new_session=True,
    )
    _managed = True
    atexit.register(stop)
    _install_signal_handlers()

    deadline = time.time() + wait_timeout
    while time.time() < deadline:
        # Check health FIRST: run_gpu.sh exits 0 when both ports were already
        # serving (its "nothing to supervise" path), which is success, not a
        # failure — so a healthy engine must win over a clean process exit.
        if _both_up():
            print(f"🚀 GPU engines ready (LLM :{config.LLM_SERVER_PORT} · "
                  f"embeddings :{config.EMBED_SERVER_PORT}).")
            return
        if _proc.poll() is not None:
            raise RuntimeError(
                f"run_gpu.sh exited (code {_proc.returncode}) before engines were ready."
            )
        time.sleep(1)

    stop()
    raise TimeoutError(f"GPU engines did not become ready within {wait_timeout}s.")


def stop() -> None:
    """Terminate the engines we started (no-op if we reused existing ones)."""
    global _proc, _managed
    if not _managed or _proc is None:
        return
    if _proc.poll() is None:
        try:
            os.killpg(os.getpgid(_proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            _proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(_proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
        print("🛑 GPU engines stopped.")
    _proc = None
    _managed = False


def _install_signal_handlers() -> None:
    # SIGINT already raises KeyboardInterrupt → normal Python unwinding, and the
    # atexit-registered stop() runs on the way out, so we leave it at default.
    # SIGTERM's default disposition kills the process WITHOUT running atexit, so
    # convert it into a clean SystemExit — that unwinds normally and lets the
    # registered stop() tear the engines down.
    def _on_sigterm(signum, frame):
        raise SystemExit(128 + signum)

    try:
        signal.signal(signal.SIGTERM, _on_sigterm)
    except (ValueError, OSError):
        pass  # not in main thread / not supported — atexit still covers us
