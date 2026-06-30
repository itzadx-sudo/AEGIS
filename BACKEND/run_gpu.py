#!/usr/bin/env python3
"""
run_gpu.py — cross-platform launcher for the Aegis llama.cpp inference engines.

Starts TWO llama_cpp.server instances, reading every setting from config.py
(the single source of truth):
  • LLM         → chat/completions on LLM_SERVER_PORT  (gemma GGUF)
  • Embeddings  → /v1/embeddings   on EMBED_SERVER_PORT (nomic GGUF)

Works on Linux, macOS and Windows. It auto-detects the platform and the
available accelerator and picks the right GPU-offload setting:

  • Linux / Windows + NVIDIA (nvidia-smi present) → offload all layers (CUDA)
  • macOS on Apple Silicon (arm64)               → offload all layers (Metal)
  • anything else                                → CPU only (0 layers)

`config.N_GPU_LAYERS` / the AEGIS_N_GPU_LAYERS env var override the auto choice.

Lifecycle:
  • Idempotent per port — a port already serving is reused, never clobbered.
  • Only the servers THIS process starts are torn down on Ctrl-C / SIGTERM /
    normal exit (handled cross-platform: process groups on POSIX, CTRL-BREAK /
    terminate on Windows).

Usage:  python run_gpu.py        (foreground; Ctrl-C stops what it started)
"""

from __future__ import annotations

import atexit
import os
import platform
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

import config

IS_WINDOWS = os.name == "nt"


# ── Accelerator auto-detection ────────────────────────────────────────────────
def detect_gpu_layers() -> tuple[int, str]:
    """Return (n_gpu_layers, human-readable backend label)."""
    # Explicit override always wins (config already folds in AEGIS_N_GPU_LAYERS).
    if "AEGIS_N_GPU_LAYERS" in os.environ:
        return config.N_GPU_LAYERS, f"forced ({config.N_GPU_LAYERS} layers)"

    system = platform.system()
    if system == "Darwin":
        if platform.machine().lower() in ("arm64", "aarch64"):
            return config.N_GPU_LAYERS, "Apple Silicon / Metal"
        # Intel Macs have no usable Metal offload for these GGUFs → CPU.
        return 0, "macOS (Intel) / CPU"

    # Linux or Windows: prefer NVIDIA CUDA if the driver tools are present.
    if shutil.which("nvidia-smi"):
        return config.N_GPU_LAYERS, f"NVIDIA CUDA ({system})"

    return 0, f"{system} / CPU (no GPU detected)"


# ── Health checks ─────────────────────────────────────────────────────────────
def port_healthy(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/v1/models", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def wait_ready(port: int, label: str, proc: subprocess.Popen | None) -> bool:
    tries = 0
    while not port_healthy(port):
        # Fast-fail: if we started this server and it has already exited, don't
        # sit through the full timeout — surface the failure now.
        if proc is not None and proc.poll() is not None:
            print(f"❌ {label} server exited (code {proc.returncode}) before becoming "
                  f"ready on :{port} — check the log above.", file=sys.stderr)
            return False
        tries += 1
        if tries > 180:
            print(f"❌ {label} did not become ready on :{port} after 180s", file=sys.stderr)
            return False
        time.sleep(1)
    print(f"✅ {label} ready on :{port}")
    return True


# ── Process management ────────────────────────────────────────────────────────
STARTED: list[subprocess.Popen] = []


def launch(model: str, port: int, n_gpu_layers: int, *, embedding: bool, ctx: int | None) -> subprocess.Popen:
    cmd = [
        config.PYBIN, "-m", "llama_cpp.server",
        "--model", model,
        "--n_gpu_layers", str(n_gpu_layers),
        "--port", str(port),
    ]
    if ctx:
        cmd += ["--n_ctx", str(ctx)]
    if embedding:
        cmd += ["--embedding", "True"]

    # New process group so we can signal the whole tree on shutdown without
    # touching servers we didn't start.
    if IS_WINDOWS:
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
        proc = subprocess.Popen(cmd, creationflags=creationflags)
    else:
        proc = subprocess.Popen(cmd, start_new_session=True)
    STARTED.append(proc)
    return proc


def stop_one(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if IS_WINDOWS:
            proc.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        try:
            if IS_WINDOWS:
                proc.kill()
            else:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            pass


_cleaned = False


def cleanup() -> None:
    global _cleaned
    if _cleaned:
        return
    _cleaned = True
    if not STARTED:
        return
    print("\nStopping GPU engine(s) started by this script…")
    for proc in STARTED:
        stop_one(proc)
    print("Stopped.")


def _signal_handler(signum, frame):  # noqa: ARG001
    cleanup()
    sys.exit(0)


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> int:
    # Sanity checks on the model files.
    if not os.path.isfile(config.LLM_GGUF_PATH):
        print(f"❌ LLM GGUF not found: {config.LLM_GGUF_PATH}", file=sys.stderr)
        print("   Set AEGIS_MODELS_DIR or AEGIS_LLM_GGUF to point at your model file.", file=sys.stderr)
        return 1
    if not os.path.isfile(config.EMBED_GGUF_PATH):
        print(f"❌ Embedding GGUF not found: {config.EMBED_GGUF_PATH}", file=sys.stderr)
        print("   Download it with:", file=sys.stderr)
        print(
            f'   "{config.PYBIN}" -c "from huggingface_hub import hf_hub_download; '
            f"hf_hub_download(repo_id='nomic-ai/nomic-embed-text-v1.5-GGUF', "
            f"filename='nomic-embed-text-v1.5.f16.gguf', "
            f"local_dir=r'{os.path.dirname(config.EMBED_GGUF_PATH)}')\"",
            file=sys.stderr,
        )
        return 1

    n_gpu_layers, backend = detect_gpu_layers()
    print(f"🖥  Platform: {platform.system()} {platform.machine()} · backend: {backend} "
          f"· n_gpu_layers={n_gpu_layers}")

    atexit.register(cleanup)
    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    llm_proc = embed_proc = None

    # LLM server
    if port_healthy(config.LLM_SERVER_PORT):
        print(f"↺ LLM already serving on :{config.LLM_SERVER_PORT} — reusing, not starting a new one.")
    else:
        print(f"▶ Starting LLM server on :{config.LLM_SERVER_PORT}  ({os.path.basename(config.LLM_GGUF_PATH)})")
        llm_proc = launch(config.LLM_GGUF_PATH, config.LLM_SERVER_PORT, n_gpu_layers,
                          embedding=False, ctx=config.LLM_NUM_CTX)

    # Embedding server
    if port_healthy(config.EMBED_SERVER_PORT):
        print(f"↺ Embeddings already serving on :{config.EMBED_SERVER_PORT} — reusing.")
    else:
        print(f"▶ Starting embedding server on :{config.EMBED_SERVER_PORT}  ({os.path.basename(config.EMBED_GGUF_PATH)})")
        embed_proc = launch(config.EMBED_GGUF_PATH, config.EMBED_SERVER_PORT, n_gpu_layers,
                            embedding=True, ctx=None)

    # Wait until both are serving (fast-fail if a server we started dies).
    if not wait_ready(config.LLM_SERVER_PORT, "LLM", llm_proc):
        cleanup()
        return 1
    if not wait_ready(config.EMBED_SERVER_PORT, "Embeddings", embed_proc):
        cleanup()
        return 1

    print(f"🚀 GPU engines ready (LLM :{config.LLM_SERVER_PORT} · "
          f"embeddings :{config.EMBED_SERVER_PORT}). Ctrl-C to stop.")

    # If we started nothing (both reused), don't hang forever.
    if not STARTED:
        print("Nothing to supervise (both reused). Exiting.")
        return 0

    # Supervise: block until interrupted or a started server dies.
    try:
        while True:
            for proc in STARTED:
                if proc.poll() is not None:
                    print(f"⚠️  A managed server exited (code {proc.returncode}). Shutting the rest down.",
                          file=sys.stderr)
                    return 1
            time.sleep(1)
    except KeyboardInterrupt:
        return 0
    finally:
        cleanup()


if __name__ == "__main__":
    sys.exit(main())
