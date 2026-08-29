import os
import time
import signal
import atexit
import subprocess
import urllib.request

import config

_RUN_GPU_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "run_gpu.sh")

_proc: subprocess.Popen | None = None   # handle to run_gpu.sh, the session leader we may own
_managed = False                        # only true if this process actually started the servers


def _port_healthy(port: int, timeout: float = 1.0) -> bool:
    url = f"http://localhost:{port}/v1/models"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _both_up() -> bool:
    return _port_healthy(config.LLM_SERVER_PORT) and _port_healthy(config.EMBED_SERVER_PORT)


def service_status() -> dict:
    return {
        "llm":        {"port": config.LLM_SERVER_PORT,   "reachable": _port_healthy(config.LLM_SERVER_PORT)},
        "embeddings": {"port": config.EMBED_SERVER_PORT, "reachable": _port_healthy(config.EMBED_SERVER_PORT)},
    }


def check_reachable() -> None:
    # fail fast — otherwise every control burns its full timeout first
    down = []
    if not _port_healthy(config.LLM_SERVER_PORT):
        down.append(f"LLM server (port {config.LLM_SERVER_PORT})")
    if not _port_healthy(config.EMBED_SERVER_PORT):
        down.append(f"embedding server (port {config.EMBED_SERVER_PORT})")
    if down:
        raise RuntimeError(
            "backend not reachable: " + ", ".join(down) + ". "
            "Start the GPU engine (python main.py assess … launches it, or run run_gpu.sh) and retry."
        )


# no-op when the models are already up
def ensure_started(wait_timeout: int = 180) -> None:
    global _proc, _managed

    if _both_up():
        print("↺ GPU engines already running — reusing.")
        return

    if not os.path.exists(_RUN_GPU_SH):
        raise FileNotFoundError(f"run_gpu.sh not found at {_RUN_GPU_SH}")

    print("▶ Starting GPU engines via run_gpu.sh …")
    # own process group, so we can kill the whole tree later
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
        # check health before exit status: run_gpu.sh exits 0 when the servers were already up
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
    # sigint already unwinds through KeyboardInterrupt into the atexit hook
    def _on_sigterm(signum, frame):
        # sigterm skips atexit by default, so turn it into a normal exit
        raise SystemExit(128 + signum)

    try:
        signal.signal(signal.SIGTERM, _on_sigterm)
    except (ValueError, OSError):
        pass  # happens off the main thread / unsupported platform — atexit is still our safety net
