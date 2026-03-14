#!/usr/bin/env bash
set -euo pipefail

MODE="debug"
DRY_RUN="0"
# BUN_MODE="${SANDBOX_BUN_MODE:-install}"
BUN_MODE=${SANDBOX_BUN_MODE:-mount}

usage() {
  cat <<'EOF'
Usage: bash scripts/run-sandbox-host.sh [--release] [--dry-run] [--bun-mode mount|install]

Build sandboxd as normal user, then run sandboxd with sudo.

Options:
  --release    Build/run release binary
  --dry-run    Set SANDBOX_DRY_RUN=1 for spec-only debug
  --bun-mode   bun strategy: mount | install
  -h, --help   Show this help

Environment passthrough (optional):
  SANDBOX_NAMESPACE
  SANDBOX_CONTAINER_ID
  SANDBOX_SNAPSHOT_KEY
  SANDBOX_IMAGE
  SANDBOX_HOST_RUNTIME_DIR
  SANDBOX_HOST_ENCLAVE_RUNTIME_DIR
  SANDBOX_CONTAINER_RUNTIME_DIR
  SANDBOX_CONTAINER_ENCLAVE_DIR
  SANDBOX_PROCESS_CWD
  SANDBOX_PROCESS_ARGS
  SANDBOX_CHILD_ENV_*
  ENCLAVE_LISTEN
  VFS_LISTEN

Defaults:
  SANDBOX_HOST_BUN_BIN      auto-detect from `command -v bun` or ~/.bun/bin/bun
  SANDBOX_CONTAINER_BUN_BIN /usr/local/bin/bun
  SANDBOX_BUN_MODE          mount
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      MODE="release"
      ;;
    --dry-run)
      DRY_RUN="1"
      ;;
    --bun-mode)
      if [[ $# -lt 2 ]]; then
        echo "--bun-mode requires a value: mount|install" >&2
        exit 1
      fi
      BUN_MODE="$2"
      shift
      ;;
    --bun-mount)
      BUN_MODE="mount"
      ;;
    --bun-install)
      BUN_MODE="install"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

if [[ "$BUN_MODE" != "mount" && "$BUN_MODE" != "install" ]]; then
  echo "Invalid bun mode: $BUN_MODE (expected mount|install)" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="$ROOT_DIR/src/sandbox/Cargo.toml"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

: "${ENCLAVE_LISTEN:=${KAIROS_ENCLAVE_SOCKET:-unix:///run/kairos-runtime/sockets/kairos-runtime-enclave.sock}}"
: "${VFS_LISTEN:=${KAIROS_VFS_SOCKET:-unix:///run/kairos-runtime/sockets/kairos-runtime-vfs.sock}}"
export ENCLAVE_LISTEN
export VFS_LISTEN

if [[ "$MODE" == "release" ]]; then
  echo "[run-sandbox-host] building sandboxd (release)..."
  cargo build --manifest-path "$MANIFEST_PATH" --release
  BIN_PATH="$ROOT_DIR/src/sandbox/target/release/sandboxd"
else
  echo "[run-sandbox-host] building sandboxd (debug)..."
  cargo build --manifest-path "$MANIFEST_PATH"
  BIN_PATH="$ROOT_DIR/src/sandbox/target/debug/sandboxd"
fi

if [[ ! -x "$BIN_PATH" ]]; then
  echo "[run-sandbox-host] binary not found: $BIN_PATH" >&2
  exit 1
fi

if [[ "$BUN_MODE" == "mount" && -z "${SANDBOX_HOST_BUN_BIN-}" ]]; then
  if command -v bun >/dev/null 2>&1; then
    SANDBOX_HOST_BUN_BIN="$(command -v bun)"
  elif [[ -x "$HOME/.bun/bin/bun" ]]; then
    SANDBOX_HOST_BUN_BIN="$HOME/.bun/bin/bun"
  fi
fi

if [[ "$BUN_MODE" == "mount" && -z "${SANDBOX_CONTAINER_BUN_BIN-}" ]]; then
  SANDBOX_CONTAINER_BUN_BIN="/usr/local/bin/bun"
fi

if [[ "$BUN_MODE" == "mount" && -n "${SANDBOX_HOST_BUN_BIN-}" ]]; then
  echo "[run-sandbox-host] using host bun: $SANDBOX_HOST_BUN_BIN -> $SANDBOX_CONTAINER_BUN_BIN"
elif [[ "$BUN_MODE" == "mount" ]]; then
  echo "[run-sandbox-host] warning: bun not auto-detected. Set SANDBOX_HOST_BUN_BIN explicitly if sandbox reports bun not found."
fi

# Auto-map host API key envs into sandbox child env when not explicitly provided.
# Priority:
#   ENCLAVE_API_KEY <- ENCLAVE_API_KEY or QWEN_API_KEY
#   CLOUD_API_KEY   <- CLOUD_API_KEY or ARK_API_KEY
if [[ -z "${SANDBOX_CHILD_ENV_ENCLAVE_API_KEY-}" ]]; then
  if [[ -n "${ENCLAVE_API_KEY-}" ]]; then
    export SANDBOX_CHILD_ENV_ENCLAVE_API_KEY="${ENCLAVE_API_KEY}"
  elif [[ -n "${QWEN_API_KEY-}" ]]; then
    export SANDBOX_CHILD_ENV_ENCLAVE_API_KEY="${QWEN_API_KEY}"
  fi
fi

if [[ -z "${SANDBOX_CHILD_ENV_CLOUD_API_KEY-}" ]]; then
  if [[ -n "${CLOUD_API_KEY-}" ]]; then
    export SANDBOX_CHILD_ENV_CLOUD_API_KEY="${CLOUD_API_KEY}"
  elif [[ -n "${ARK_API_KEY-}" ]]; then
    export SANDBOX_CHILD_ENV_CLOUD_API_KEY="${ARK_API_KEY}"
  fi
fi

if [[ -n "${SANDBOX_CHILD_ENV_ENCLAVE_API_KEY-}" ]]; then
  echo "[run-sandbox-host] forwarding child env: ENCLAVE_API_KEY"
fi
if [[ -n "${SANDBOX_CHILD_ENV_CLOUD_API_KEY-}" ]]; then
  echo "[run-sandbox-host] forwarding child env: CLOUD_API_KEY"
fi

echo "[run-sandbox-host] bun mode: $BUN_MODE"

echo "[run-sandbox-host] starting with sudo: $BIN_PATH"

declare -a SUDO_ENV=(
  "PATH=$PATH"
  "SANDBOX_DRY_RUN=$DRY_RUN"
  "SANDBOX_BUN_MODE=$BUN_MODE"
)

pass_env_if_set() {
  local name="$1"
  if [[ -n "${!name-}" ]]; then
    SUDO_ENV+=("$name=${!name}")
  fi
}

for env_name in \
  SANDBOX_NAMESPACE \
  SANDBOX_CONTAINER_ID \
  SANDBOX_SNAPSHOT_KEY \
  SANDBOX_SNAPSHOT_PARENT \
  SANDBOX_BUN_MODE \
  SANDBOX_IMAGE \
  SANDBOX_HOST_BUN_BIN \
  SANDBOX_CONTAINER_BUN_BIN \
  SANDBOX_HOST_RUNTIME_DIR \
  SANDBOX_HOST_ENCLAVE_RUNTIME_DIR \
  SANDBOX_HOST_WORKSPACE_DIR \
  SANDBOX_CONTAINER_RUNTIME_DIR \
  SANDBOX_CONTAINER_WORKSPACE_DIR \
  SANDBOX_CONTAINER_ENCLAVE_DIR \
  SANDBOX_PROCESS_CWD \
  SANDBOX_PROCESS_ARGS \
  ENCLAVE_LISTEN \
  VFS_LISTEN
do
  pass_env_if_set "$env_name"
done

while IFS='=' read -r key _value; do
  if [[ "$key" == SANDBOX_CHILD_ENV_* ]]; then
    SUDO_ENV+=("$key=${!key}")
  fi
done < <(env)

sudo --preserve-env=PATH env "${SUDO_ENV[@]}" "$BIN_PATH"
