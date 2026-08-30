#!/usr/bin/env bash
# Start, adopt, or stop Sedona's local model, embedding, API, and frontend services.
#
#   ./start.sh                     start what is down, reuse what is already healthy
#   ./start.sh --adopt             ...and take ownership of the healthy ones, so Ctrl-C stops them
#   ./start.sh --stop              stop this checkout's API and frontend
#   ./start.sh --stop --engines    ...and the llama.cpp engines (llama_cpp backend only)
#   ./start.sh --restart-api       replace only the API process (backend code changed)
#
# Ownership is proven before anything is signalled: a process counts as ours only when its
# working directory resolves inside this checkout. Nothing is ever killed by port, so a second
# Sedona elsewhere on the host, or a hand-started engine, is never disturbed.
#
# Under the ollama backend (the macOS default) there are no engines to manage: one shared daemon
# serves both models, Sedona never owns it, and --engines therefore has nothing to act on.
#
# Plain `./start.sh` still reuses healthy services without adopting them, so a bare run stays
# a safe health check that cannot take the GPU engines down on Ctrl-C. The cost of that is the
# failure mode this script used to have no answer for: a detached supervisor from an earlier
# launch keeps running with no controlling terminal, so no Ctrl-C can ever reach it, and every
# later run just prints "nothing to manage" and exits. --adopt and --stop are the way out.
set -euo pipefail

# macOS ships bash 3.2 (no mapfile), has no /proc, no ss, no ip and no setsid. Every primitive
# that differs is isolated behind a helper below rather than sprinkled through the logic.
case "$(uname -s)" in
  Darwin) IS_MACOS=1 ;;
  *)      IS_MACOS=0 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$HERE/BACKEND"
FRONTEND_DIR="$HERE/FRONTEND"
cd "$HERE"
DATA_DIR="${SEDONA_DATA_DIR:-$HERE}"
LOG_DIR="${SEDONA_LOG_DIR:-$DATA_DIR/logs}"

API_HOST="${SEDONA_API_HOST:-127.0.0.1}"
API_PORT="${SEDONA_API_PORT:-8080}"
FRONTEND_HOST="${SEDONA_FRONTEND_HOST:-0.0.0.0}"
FRONTEND_PORT="${SEDONA_FRONTEND_PORT:-5173}"

# The frontend binds a wildcard address, so "localhost" is only the right URL for someone already
# on the box — the operator reaches it over the network. Derive the host address instead of
# hardcoding it: a deployment's address belongs in the environment, not in source, and a
# hardcoded one goes stale the first time the VM moves. SEDONA_PUBLIC_URL still wins when set.
host_address() {
  local addr=""
  if (( IS_MACOS )); then
    # no `ip` and no `hostname -I`; ask the interfaces directly, wired before wireless
    local iface
    for iface in $(route -n get default 2>/dev/null | sed -n 's/.*interface: *//p') en0 en1; do
      addr="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      [[ -n "$addr" ]] && break
    done
  else
    addr="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p')"
    [[ -n "$addr" ]] || addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  printf '%s\n' "$addr"
}
case "$FRONTEND_HOST" in
  0.0.0.0|::|'*') HOST_ADDR="$(host_address)" ;;
  *)              HOST_ADDR="" ;;
esac
PUBLIC_URL="${SEDONA_PUBLIC_URL:-http://${HOST_ADDR:-localhost}:$FRONTEND_PORT}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log()  { echo -e "${CYAN}[sedona]${RESET} $*"; }
ok()   { echo -e "${GREEN}  [ok] $*${RESET}"; }
warn() { echo -e "${YELLOW}  [warn] $*${RESET}"; }
fail() { echo -e "${RED}  [error] $*${RESET}"; }

usage() {
  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

MODE="start"
ADOPT=0
INCLUDE_ENGINES=0
while (( $# )); do
  case "$1" in
    --stop)                MODE="stop" ;;
    --restart-api)         MODE="restart-api" ;;
    --adopt)               ADOPT=1 ;;
    --engines|--with-engines) INCLUDE_ENGINES=1 ;;
    -h|--help)             usage; exit 0 ;;
    *) fail "Unknown option: $1"; echo; usage >&2; exit 2 ;;
  esac
  shift
done

# Resolve an interpreter that actually has Sedona's dependencies. Defaulting straight to
# `command -v python3` picks the system interpreter, which has no uvicorn — the API then dies
# on launch with "No module named uvicorn" and the frontend proxy answers 500 to everything.
# That stayed hidden while services were already running, because start.sh reuses healthy ones.
# Resolution is lazy so that --stop still works on a box whose venv is broken, which is exactly
# when you most need to be able to stop things.
_usable_python() {
  [[ -x "$1" ]] && "$1" -c 'import uvicorn, fastapi' >/dev/null 2>&1
}
PYBIN=""
_find_python() {
  local candidate
  for candidate in \
    "${SEDONA_PYBIN:-}" \
    "$HERE/BACKEND/.venv/bin/python" \
    "$HERE/.venv/bin/python" \
    "${SEDONA_RUNTIME_DIR:-$HERE/.runtime}/venv/bin/python" \
    "$HOME/.pyenv/versions/aegis-env-3.12/bin/python" \
    "$(command -v python3 || true)"
  do
    [[ -n "$candidate" ]] || continue
    if _usable_python "$candidate"; then PYBIN="$candidate"; return 0; fi
  done
  return 1
}

resolve_pybin() {
  [[ -n "$PYBIN" ]] && return 0
  _find_python && return 0

  # Nothing on this box can run Sedona. On a fresh checkout that is the normal first run, not an
  # error, so bootstrap the environment into this folder and look again. An existing install is
  # always preferred above — this only fires when there is genuinely nothing to use, so it can
  # never take over a working deployment.
  if [[ -x "$HERE/scripts/bootstrap.sh" ]]; then
    warn "No Python with Sedona's dependencies found — running first-time setup."
    log  "Installing into ${SEDONA_RUNTIME_DIR:-$HERE/.runtime} (nothing outside this folder)."
    if bash "$HERE/scripts/bootstrap.sh"; then
      _find_python && return 0
    fi
  fi

  fail "No Python with Sedona's dependencies found. Run ./scripts/bootstrap.sh, or set"
  fail "SEDONA_PYBIN to an interpreter that already has them."
  exit 1
}

# macOS has no setsid. That matters beyond the missing binary: a backgrounded subshell in a
# non-interactive shell is NOT a process group leader, so cleanup()'s `kill -TERM -- "-$pid"`
# would quietly fall through to the single-PID path and orphan uvicorn's and Vite's children.
# Re-exec through Python's os.setsid() instead, which gives a real session either way.
DETACH=()
resolve_detach() {
  (( ${#DETACH[@]} )) && return 0
  if command -v setsid >/dev/null 2>&1; then
    DETACH=(setsid)
  else
    resolve_pybin
    DETACH=("$PYBIN" -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])')
  fi
  return 0
}

# ── Portability helpers ──────────────────────────────────────────────────────
# bash 3.2 has no mapfile, and `arr=( $(cmd) )` would word-split on the paths and command lines
# these arrays hold. Read line by line instead; dynamic scoping lets the caller's `local -a`
# array be the one filled in.  Usage: read_lines <array-name> <command> [args...]
read_lines() {
  local __arr="$1"; shift
  local __line
  eval "$__arr=()"
  while IFS= read -r __line; do
    [[ -n "$__line" ]] || continue
    eval "$__arr+=(\"\$__line\")"
  done < <("$@")
}

# ── Process inspection ───────────────────────────────────────────────────────
if (( IS_MACOS )); then
  proc_cmd() { ps -o command= -p "$1" 2>/dev/null; }
  # lsof is the only way to read another process's cwd on macOS; -Fn prefixes the path with 'n'
  proc_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }
  proc_ppid() {
    local ppid
    ppid="$(ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ')" || return 1
    [[ -n "$ppid" ]] || return 1
    printf '%s\n' "$ppid"
  }
else
  proc_cmd() { tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null; }
  proc_cwd() { readlink "/proc/$1/cwd" 2>/dev/null; }

  proc_ppid() {
    local stat
    stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
    stat="${stat##*') '}"   # comm is parenthesised and may contain spaces; skip past it
    # shellcheck disable=SC2086
    set -- $stat            # $1 = state, $2 = ppid
    printf '%s\n' "$2"
  }
fi

# A zombie still answers `kill -0`, so a liveness check that only uses that would wait forever
# on a child nobody has reaped.
alive() {
  kill -0 "$1" 2>/dev/null || return 1
  [[ "$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')" != Z* ]]
}

if (( IS_MACOS )); then
  port_held() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
else
  port_held() { ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }
fi

# Emits "label<TAB>pid" for every Sedona process that provably belongs to THIS checkout.
# proc_cwd is the proof: run_gpu.sh's engines sit in BACKEND, uvicorn and Vite in FRONTEND.
# Another user's processes are skipped automatically because their cwd is unreadable.
discover_sedona() {
  local pid cmd cwd
  for pid in $(pgrep -u "$(id -u)" -f 'uvicorn api:app|llama_cpp\.server|vite|npm run dev' 2>/dev/null || true); do
    [[ "$pid" == "$$" || "$pid" == "${PPID:-0}" ]] && continue
    cmd="$(proc_cmd "$pid")"
    cwd="$(proc_cwd "$pid")"
    [[ -n "$cwd" ]] || continue           # exited between pgrep and here, or not ours to read
    [[ "$cmd" == *pgrep* ]] && continue   # never match the search itself
    case "$cmd" in
      *"uvicorn api:app"*)
        [[ "$cwd" == "$FRONTEND_DIR" ]] && printf 'API\t%s\n' "$pid"
        ;;
      *llama_cpp.server*)
        [[ "$cwd" == "$BACKEND_DIR" ]] || continue
        if [[ "$cmd" == *"--embedding True"* ]]; then
          printf 'embeddings\t%s\n' "$pid"
        else
          printf 'LLM\t%s\n' "$pid"
        fi
        ;;
      *vite*|*"npm run dev"*)
        [[ "$cwd" == "$FRONTEND_DIR" ]] && printf 'frontend\t%s\n' "$pid"
        ;;
    esac
  done
  return 0
}

# A leftover supervisor is the case that punishes naive killing: its own cleanup trap stops
# every service it started, so picking off one of its children makes it tear down the rest on
# its way out. Signal the supervisor instead and let its trap do an orderly teardown.
# The outermost start.sh ancestor is the real supervisor — its subshells share the same argv.
# A `bash -c '...start.sh...'` launcher only mentions the script and must not be matched.
supervisor_of() {
  local pid="$1" hops=0 cmd top=""
  while (( hops < 24 )); do
    pid="$(proc_ppid "$pid")" || break
    [[ -n "$pid" && "$pid" != 0 && "$pid" != 1 ]] || break
    [[ "$pid" == "$$" ]] && return 1      # ours; not a leftover
    cmd="$(proc_cmd "$pid")"
    if [[ "$cmd" != *" -c "* && "$cmd" == *start.sh* ]]; then top="$pid"; fi
    hops=$(( hops + 1 ))
  done
  [[ -n "$top" ]] || return 1
  printf '%s\n' "$top"
}

# TERM, wait, then KILL. Escalation is deliberate here, unlike the "leaving it running for
# operator review" path for services this run started: --stop is an explicit request for the
# process to be gone, and a wedged llama.cpp server holds the GPU until it is.
stop_entries() {
  (( $# )) || return 0
  local entry label pid deadline survivors
  for entry in "$@"; do
    label="${entry%%:*}"; pid="${entry##*:}"
    alive "$pid" || continue
    log "Stopping $label (pid $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
  done
  deadline=$(( SECONDS + 15 ))
  while (( SECONDS < deadline )); do
    survivors=0
    for entry in "$@"; do alive "${entry##*:}" && survivors=1; done
    (( survivors )) || break
    sleep 1
  done
  for entry in "$@"; do
    label="${entry%%:*}"; pid="${entry##*:}"
    if alive "$pid"; then
      warn "$label (pid $pid) ignored TERM after 15s; sending KILL."
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  return 0
}

# Only the llama_cpp backend has engines of its own. Under ollama, discover_sedona finds no
# llama_cpp.server processes at all — and the ollama daemon is deliberately not in its search
# pattern, so --adopt and --stop --engines can never take over or kill shared user infrastructure.
in_scope_label() {
  case "$1" in
    LLM|embeddings) (( INCLUDE_ENGINES )) ;;
    *) return 0 ;;
  esac
}

# Stop everything in scope that belongs to this checkout. $1=1 refuses to proceed when doing so
# would drag out-of-scope services down with a shared supervisor; $1=0 skips that guard, for
# teardown of services this run already committed to owning.
stop_scope() {
  local guard="${1:-1}"
  local -a found=() targets=() spared=() supervisors=() ports=()
  local entry label pid sup other

  read_lines found discover_sedona
  if (( ${#found[@]} == 0 )); then
    ok "No Sedona processes from this checkout are running."
    return 0
  fi

  for entry in "${found[@]}"; do
    label="${entry%%$'\t'*}"; pid="${entry##*$'\t'}"
    if in_scope_label "$label"; then
      targets+=("$label:$pid")
      case "$label" in
        # read the port from the cmdline while the process still exists to read it from
        LLM|embeddings) if [[ "$(proc_cmd "$pid")" =~ --port[[:space:]]+([0-9]+) ]]; then ports+=("$label:${BASH_REMATCH[1]}"); fi ;;
        API)            ports+=("API:$API_PORT") ;;
        frontend)       ports+=("frontend:$FRONTEND_PORT") ;;
      esac
    else
      spared+=("$label:$pid")
    fi
  done

  if (( ${#targets[@]} == 0 )); then
    ok "Nothing in scope is running. Inference engines are up; pass --engines to include them."
    return 0
  fi

  for entry in "${targets[@]}"; do
    sup="$(supervisor_of "${entry##*:}" || true)"
    [[ -n "$sup" ]] || continue
    [[ " ${supervisors[*]:-} " == *" $sup "* ]] && continue
    supervisors+=("$sup")
  done

  if (( guard )); then
    for sup in "${supervisors[@]:-}"; do
      [[ -n "$sup" ]] || continue
      for other in "${spared[@]:-}"; do
        [[ -n "$other" ]] || continue
        if [[ "$(supervisor_of "${other##*:}" || true)" == "$sup" ]]; then
          fail "Supervisor pid $sup also started ${other%%:*} (pid ${other##*:})."
          echo "  Its cleanup trap stops everything it started, so the inference engines cannot"
          echo "  be spared while it is the thing holding the frontend and API."
          echo "  Re-run with --engines to stop those too; the models then take minutes to reload."
          return 1
        fi
      done
    done
  fi

  # Supervisors first, so their own traps do the orderly part of the teardown.
  local -a sup_entries=()
  for sup in "${supervisors[@]:-}"; do
    [[ -n "$sup" ]] && sup_entries+=("supervisor:$sup")
  done
  (( ${#sup_entries[@]} )) && stop_entries "${sup_entries[@]}"
  stop_entries "${targets[@]}"

  # A supervisor that gave up on a stubborn child warns and leaves it; re-sweep so --stop means
  # stopped. This also catches a child respawned by npm between the two passes.
  local -a leftovers=()
  read_lines found discover_sedona
  for entry in "${found[@]:-}"; do
    [[ -n "$entry" ]] || continue
    label="${entry%%$'\t'*}"; pid="${entry##*$'\t'}"
    in_scope_label "$label" && leftovers+=("$label:$pid")
  done
  (( ${#leftovers[@]} )) && stop_entries "${leftovers[@]}"

  # Verify against the ports, not against our own bookkeeping. uvicorn holds :8080 for a moment
  # after TERM, and a port still LISTENing is what makes the next launch die with EADDRINUSE.
  local rc=0 i port
  for entry in "${ports[@]:-}"; do
    [[ -n "$entry" ]] || continue
    label="${entry%%:*}"; port="${entry##*:}"
    for i in $(seq 1 30); do
      port_held "$port" || break
      sleep 1
    done
    if port_held "$port"; then
      fail "Port $port ($label) is still held."
      rc=1
    else
      ok "$label stopped; port $port is free."
    fi
  done

  if (( ${#spared[@]} )); then
    log "Left running: ${spared[*]} (pass --engines to include them)."
  fi
  return "$rc"
}

if [[ "$MODE" == "stop" ]]; then
  echo
  echo -e "${BOLD}SEDONA Risk Console${RESET} — stopping"
  echo
  if stop_scope 1; then exit 0; fi
  exit 1
fi

# --restart-api replaces just the API process, for when backend code changed. It exists because
# the obvious kill-and-relaunch races: uvicorn holds the port for a moment after TERM, the new
# process dies with EADDRINUSE, and the API stays down while the frontend proxy answers 500 to
# every request. Only the PID whose cwd is this checkout's FRONTEND is stopped, so a second
# Sedona on the same host is never touched, and nothing is killed by port.
if [[ "$MODE" == "restart-api" ]]; then
  resolve_pybin
  mkdir -p "$LOG_DIR"
  for pid in $(pgrep -f "uvicorn api:app" || true); do
    [[ "$(proc_cwd "$pid")" == "$FRONTEND_DIR" ]] || continue
    log "Stopping API (pid $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 30); do
    port_held "$API_PORT" || break
    sleep 1
  done
  if port_held "$API_PORT"; then
    fail "Port $API_PORT is still held; not rebinding."
    exit 1
  fi
  resolve_detach
  ( cd "$FRONTEND_DIR" && exec "${DETACH[@]}" nohup "$PYBIN" -m uvicorn api:app \
      --host "$API_HOST" --port "$API_PORT" >> "$LOG_DIR/api.log" 2>&1 ) &
  for _ in $(seq 1 40); do
    sleep 1
    if curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
      ok "API is ready."; exit 0
    fi
  done
  fail "API did not become ready. Inspect $LOG_DIR/api.log."
  exit 1
fi

resolve_pybin
mkdir -p "$LOG_DIR"

port_up() { curl -sf "http://127.0.0.1:$1/v1/models" >/dev/null 2>&1; }
api_up()  { curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; }
ui_up()   { curl -sf "http://127.0.0.1:$FRONTEND_PORT/" >/dev/null 2>&1; }

OWNED_PIDS=()
OWNED_LABELS=()
ADOPTED=0

start_owned() {
  local label="$1"
  local work_dir="$2"
  local log_file="$3"
  shift 3

  resolve_detach
  (
    cd "$work_dir"
    exec "${DETACH[@]}" "$@" > "$log_file" 2>&1
  ) &
  local pid=$!
  OWNED_PIDS+=("$pid")
  OWNED_LABELS+=("$label")
  log "Started $label (process group $pid)."
}

cleanup() {
  if [[ -n "${SEDONA_CLEANED:-}" ]]; then
    return
  fi
  SEDONA_CLEANED=1

  if (( ${#OWNED_PIDS[@]} == 0 && ADOPTED == 0 )); then
    return
  fi

  if (( ${#OWNED_PIDS[@]} > 0 )); then
    log "Stopping services started by this supervisor..."
    local i pid
    for i in "${!OWNED_PIDS[@]}"; do
      pid="${OWNED_PIDS[$i]}"
      if kill -0 "$pid" 2>/dev/null; then
        kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      fi
    done

    local deadline=$((SECONDS + 15))
    while (( SECONDS < deadline )); do
      local alive_any=0
      for pid in "${OWNED_PIDS[@]}"; do
        kill -0 "$pid" 2>/dev/null && alive_any=1
      done
      (( alive_any == 0 )) && break
      sleep 1
    done

    for pid in "${OWNED_PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        warn "Process group $pid did not stop after 15 seconds; leaving it running for operator review."
      fi
    done
  fi

  if (( ADOPTED )); then
    log "Stopping adopted services..."
    stop_scope 0 || true
  fi
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo
echo -e "${BOLD}SEDONA Risk Console${RESET}"
echo

# Adoption happens before the health checks, so the reuse branches below report a service this
# run is genuinely responsible for. A service belonging to a live supervisor is adopted through
# that supervisor: signalling its children directly would make it tear down the rest as it exits.
adopt_running() {
  local -a found=() supervisors=() spared=()
  local entry label pid sup
  read_lines found discover_sedona
  (( ${#found[@]} )) || { log "Nothing is running yet; nothing to adopt."; return 0; }
  for entry in "${found[@]}"; do
    label="${entry%%$'\t'*}"; pid="${entry##*$'\t'}"
    sup="$(supervisor_of "$pid" || true)"
    if ! in_scope_label "$label"; then
      log "Not adopting $label (pid $pid); pass --engines to include it."
      spared+=("$label:$pid:${sup:-none}")
      continue
    fi
    ADOPTED=1
    if [[ -n "$sup" ]]; then
      log "Adopting $label (pid $pid) via its supervisor (pid $sup)."
      [[ " ${supervisors[*]:-} " == *" $sup "* ]] || supervisors+=("$sup")
    else
      log "Adopting orphaned $label (pid $pid)."
    fi
  done
  (( ADOPTED )) || { log "Nothing in scope to adopt."; return 0; }
  # Adopting through a supervisor inherits its blast radius: its cleanup trap stops everything it
  # started, so a service left out of scope still goes down with it. Better said now than found
  # out by Ctrl-C.
  for entry in "${spared[@]:-}"; do
    [[ -n "$entry" ]] || continue
    sup="${entry##*:}"
    [[ "$sup" != none && " ${supervisors[*]:-} " == *" $sup "* ]] || continue
    label="${entry%%:*}"
    warn "$label is out of scope but was started by adopted supervisor $sup; Ctrl-C will stop it too."
  done
  ok "Ctrl-C will stop the adopted services."
  return 0
}

# The failure the operator actually hits: everything is healthy, so this run has nothing to
# manage and exits — while a detached supervisor from an earlier launch keeps the services up
# where no Ctrl-C can reach it. Say so, and name the way out.
report_unmanaged() {
  local -a found=()
  local entry label pid sup
  read_lines found discover_sedona
  (( ${#found[@]} )) || return 0
  for entry in "${found[@]}"; do
    label="${entry%%$'\t'*}"; pid="${entry##*$'\t'}"
    sup="$(supervisor_of "$pid" || true)"
    [[ -n "$sup" ]] || continue
    warn "Reused $label (pid $pid) belongs to supervisor pid $sup, not to this run."
  done
  echo "  This run will not stop reused services on Ctrl-C. Use './start.sh --adopt' to take"
  echo "  ownership of them, or './start.sh --stop [--engines]' to shut them down."
  return 0
}

if (( ADOPT )); then
  log "Taking ownership of services that are already running..."
  adopt_running
fi

log "Checking local inference services..."
# config.py stays the single source of truth for the shell scripts, exactly as run_gpu.sh does it
read_cfg() { "$PYBIN" -c "import sys; sys.path.insert(0, '$HERE/BACKEND'); import config; print(config.$1)"; }
LLM_BACKEND="$(read_cfg LLM_BACKEND)"
LLM_PORT="$(read_cfg LLM_SERVER_PORT)"
EMBED_PORT="$(read_cfg EMBED_SERVER_PORT)"

if port_up "$LLM_PORT" && port_up "$EMBED_PORT"; then
  ok "LLM and embeddings are already healthy; reusing them."
  # a daemon that is up but missing the tag passes this check and then fails every control
  if [[ "$LLM_BACKEND" == "ollama" ]]; then
    ( cd "$BACKEND_DIR" && "$PYBIN" -c 'import gpu_engine; gpu_engine.warn_missing_models()' ) || true
  fi
elif [[ "$LLM_BACKEND" == "ollama" ]]; then
  # One shared daemon serves both models, and it is not ours: on macOS it is normally the
  # Ollama.app menu-bar agent. Sedona never starts it and never stops it, so there is nothing to
  # own here — just say what to do.
  fail "Ollama is not answering on port $LLM_PORT."
  echo "  Start it (open Ollama.app, or run 'ollama serve'), then re-run ./start.sh."
  echo "  First time on this machine, sign in and fetch the two models:"
  echo "    ollama signin"
  echo "    ollama pull $(read_cfg LLM_MODEL)"
  echo "    ollama pull $(read_cfg EMBED_MODEL)"
  exit 1
else
  # a python carrying the API's dependencies says nothing about whether the engines can run, so
  # check the whole install here — otherwise a missing piece only shows up as a silent wait
  if [[ -x "$HERE/scripts/bootstrap.sh" ]] && ! bash "$HERE/scripts/bootstrap.sh" --check >/dev/null 2>&1; then
    warn "Setup is incomplete — finishing it before starting the engines."
    bash "$HERE/scripts/bootstrap.sh" || fail "setup did not complete; see the output above"
  fi
  start_owned "GPU engines" "$BACKEND_DIR" "$LOG_DIR/llm.log" bash "$BACKEND_DIR/run_gpu.sh"
  log "Waiting for the LLM and embedding services..."
  for i in $(seq 1 480); do
    if port_up "$LLM_PORT" && port_up "$EMBED_PORT"; then
      ok "LLM and embeddings are ready."
      break
    fi
    if (( i == 480 )); then
      fail "Inference services did not become ready. Inspect $LOG_DIR/llm.log."
      exit 1
    fi
    sleep 1
  done
fi

log "Checking API service..."
if api_up; then
  ok "API is already healthy; reusing it."
else
  start_owned \
    "API" "$FRONTEND_DIR" "$LOG_DIR/api.log" \
    "$PYBIN" -m uvicorn api:app --host "$API_HOST" --port "$API_PORT"
  for i in $(seq 1 30); do
    if api_up; then
      ok "API is ready."
      break
    fi
    if (( i == 30 )); then
      fail "API did not become ready. Inspect $LOG_DIR/api.log."
      exit 1
    fi
    sleep 1
  done
fi

log "Checking frontend service..."
if ui_up; then
  ok "Frontend is already healthy; reusing it."
else
  if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    fail "Frontend dependencies are missing. Run 'npm ci' in FRONTEND before startup."
    exit 1
  fi
  start_owned \
    "frontend" "$FRONTEND_DIR" "$LOG_DIR/frontend.log" \
    npm run dev -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT"
  for i in $(seq 1 30); do
    if ui_up; then
      ok "Frontend is ready."
      break
    fi
    if (( i == 30 )); then
      fail "Frontend did not become ready. Inspect $LOG_DIR/frontend.log."
      exit 1
    fi
    sleep 1
  done
fi

echo
ok "Sedona is running at $PUBLIC_URL"
echo "  Logs: $LOG_DIR"

if (( ${#OWNED_PIDS[@]} == 0 && ADOPTED == 0 )); then
  log "All services were reused; this supervisor has nothing to manage."
  report_unmanaged
  trap - INT TERM EXIT
  exit 0
fi

if (( ADOPTED )); then
  # Adopted processes are not our children, so `wait` would return immediately and the EXIT trap
  # would tear down the very services we just adopted. Poll instead, and let the signal traps fire.
  log "Supervising. Ctrl-C stops Sedona."
  while :; do
    running=0
    while IFS=$'\t' read -r label pid; do
      [[ -n "$pid" ]] || continue
      in_scope_label "$label" && running=1
    done < <(discover_sedona)
    (( running )) || break
    sleep 3
  done
  log "No Sedona services are left running."
  exit 0
fi

wait
