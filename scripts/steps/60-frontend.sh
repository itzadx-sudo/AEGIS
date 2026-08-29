#!/usr/bin/env bash
# Install the frontend's node packages.
#
# start.sh refuses to launch without node_modules, so on a fresh checkout this is the difference
# between "./start.sh" working and it stopping to tell you to run npm yourself.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

STEP=frontend
FRONTEND_DIR="$PROJECT_ROOT/FRONTEND"

[[ -d "$FRONTEND_DIR" ]] || die "no FRONTEND directory at $FRONTEND_DIR"

if is_done "$STEP" && [[ -d "$FRONTEND_DIR/node_modules" ]]; then
  ok "frontend dependencies already installed"
  exit 0
fi

need_cmd npm || die "npm is not installed.
       Node is the one dependency this bootstrap cannot install for you — fetching a Node
       toolchain is outside what these scripts do. Install Node 18+ and re-run."

log "installing frontend packages (npm)"
# ci is reproducible and matches the lockfile; fall back for a checkout without one
if [[ -f "$FRONTEND_DIR/package-lock.json" ]]; then
  (cd "$FRONTEND_DIR" && npm ci --silent)
else
  (cd "$FRONTEND_DIR" && npm install --silent)
fi

[[ -d "$FRONTEND_DIR/node_modules" ]] || die "npm finished but node_modules is still missing"

ok "frontend dependencies installed"
mark_done "$STEP"
