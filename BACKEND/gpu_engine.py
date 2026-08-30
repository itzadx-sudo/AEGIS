import os
import json
import time
import shutil
import signal
import atexit
import subprocess
import urllib.request

import config

_RUN_GPU_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "run_gpu.sh")

# under the ollama backend there is nothing to compile, launch or supervise per-model: one daemon
# serves both, and *-cloud tags are proxied to ollama.com by the daemon itself
_OLLAMA = config.LLM_BACKEND == "ollama"

_proc: subprocess.Popen | None = None   # the session leader we may own (run_gpu.sh, or ollama serve)
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


# A daemon that is up but missing the tag answers /v1/models with a healthy 200 and then fails
# every single control, one full timeout at a time. Ask what it actually has.
def _ollama_tags(timeout: float = 3.0) -> set[str]:
    url = f"http://{config.LLM_SERVER_HOST}:{config.LLM_SERVER_PORT}/api/tags"
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    names: set[str] = set()
    for entry in data.get("models", []):
        name = entry.get("name") or entry.get("model") or ""
        if not name:
            continue
        names.add(name)
        # ollama reports "nomic-embed-text:latest"; config may name it "nomic-embed-text"
        names.add(name.split(":", 1)[0])
    return names


def service_status() -> dict:
    status = {
        "backend":    config.LLM_BACKEND,
        "llm":        {"port": config.LLM_SERVER_PORT,   "reachable": _port_healthy(config.LLM_SERVER_PORT),
                       "model": config.LLM_MODEL},
        "embeddings": {"port": config.EMBED_SERVER_PORT, "reachable": _port_healthy(config.EMBED_SERVER_PORT),
                       "model": config.EMBED_MODEL},
    }
    if not _OLLAMA or not (status["llm"]["reachable"] or status["embeddings"]["reachable"]):
        return status

    try:
        tags = _ollama_tags()
    except Exception:
        return status  # the probe is a refinement, never a reason to report a healthy port as down

    for key in ("llm", "embeddings"):
        model = status[key]["model"]
        status[key]["model_present"] = model in tags
        if not status[key]["model_present"]:
            status[key]["reachable"] = False
            status[key]["error"] = f"model '{model}' is not pulled — run: ollama pull {model}"
    return status


def check_reachable() -> None:
    # fail fast — otherwise every control burns its full timeout first
    status = service_status()

    if _OLLAMA:
        # one daemon serves both, so naming it twice would just be noise
        problems = [
            svc["error"] for svc in (status["llm"], status["embeddings"])
            if svc.get("error")
        ]
        if not status["llm"]["reachable"] and not problems:
            raise RuntimeError(
                f"Ollama is not reachable on port {config.LLM_SERVER_PORT}. "
                "Start it (open Ollama.app, or run `ollama serve`) and retry."
            )
        if problems:
            raise RuntimeError("Ollama is running but not ready: " + "; ".join(dict.fromkeys(problems)))
        return

    down = []
    if not status["llm"]["reachable"]:
        down.append(f"LLM server (port {config.LLM_SERVER_PORT})")
    if not status["embeddings"]["reachable"]:
        down.append(f"embedding server (port {config.EMBED_SERVER_PORT})")
    if down:
        raise RuntimeError(
            "backend not reachable: " + ", ".join(down) + ". "
            "Start the GPU engine (python main.py assess … launches it, or run run_gpu.sh) and retry."
        )


# no-op when the models are already up
def ensure_started(wait_timeout: int = 180) -> None:
    global _proc, _managed

    if _OLLAMA:
        _ensure_ollama(wait_timeout)
        return

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


# Normally a no-op: on macOS the Ollama.app menu-bar agent already holds :11434, and a daemon we
# did not start is never ours to stop. We only take ownership when nothing was listening at all.
def _ensure_ollama(wait_timeout: int) -> None:
    global _proc, _managed

    if _port_healthy(config.LLM_SERVER_PORT):
        print(f"↺ Ollama already serving on :{config.LLM_SERVER_PORT} — reusing.")
        warn_missing_models()
        return

    exe = shutil.which("ollama")
    if not exe:
        raise RuntimeError(
            f"Ollama is not running on port {config.LLM_SERVER_PORT} and the `ollama` command was "
            "not found. Install it from https://ollama.com/download, then run `ollama signin` to "
            "enable the cloud models."
        )

    print("▶ Starting the Ollama daemon (ollama serve) …")
    _proc = subprocess.Popen(
        [exe, "serve"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,   # own process group, so we can kill the whole tree later
    )
    _managed = True
    atexit.register(stop)
    _install_signal_handlers()

    deadline = time.time() + wait_timeout
    while time.time() < deadline:
        if _port_healthy(config.LLM_SERVER_PORT):
            print(f"🚀 Ollama ready on :{config.LLM_SERVER_PORT} "
                  f"(chat: {config.LLM_MODEL} · embeddings: {config.EMBED_MODEL}).")
            warn_missing_models()
            return
        if _proc.poll() is not None:
            raise RuntimeError(
                f"`ollama serve` exited (code {_proc.returncode}) before becoming ready. "
                "If Ollama.app is already running, that port is taken by it."
            )
        time.sleep(1)

    stop()
    raise TimeoutError(f"Ollama did not become ready within {wait_timeout}s.")


# Warn rather than raise: pulling is the operator's call, and ingest/stats can still be useful.
# check_reachable() is what actually blocks an assessment. start.sh calls this too, so a missing
# tag is reported at launch rather than discovered one failed control at a time.
def warn_missing_models() -> None:
    try:
        tags = _ollama_tags()
    except Exception:
        return
    for model in (config.LLM_MODEL, config.EMBED_MODEL):
        if model not in tags:
            print(f"⚠ model '{model}' is not pulled — run: ollama pull {model}")


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
        print("🛑 Ollama daemon stopped." if _OLLAMA else "🛑 GPU engines stopped.")
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
