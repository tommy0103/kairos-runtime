#!/usr/bin/env bash
set -euo pipefail

MODE="release"
BUILD_BACKEND="docker"
RUST_IMAGE="rust:bookworm"

usage() {
  echo "Usage: bash scripts/build-vfs.sh [--debug|--release] [--docker|--native]"
  echo
  echo "Build memory-vfs artifact at .artifacts/memory-vfs."
  echo "Defaults:"
  echo "  --release --docker"
  echo
  echo "Notes:"
  echo "  --docker builds with ${RUST_IMAGE} to avoid host/container glibc mismatch."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug|-d)
      MODE="debug"
      ;;
    --release|-r)
      MODE="release"
      ;;
    --docker)
      BUILD_BACKEND="docker"
      ;;
    --native)
      BUILD_BACKEND="native"
      ;;
    --help|-h)
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

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="$ROOT_DIR/.artifacts"
ARTIFACT_PATH="$ARTIFACT_DIR/memory-vfs"
TARGET_DIR="$ROOT_DIR/src/vfs/target"

mkdir -p "$ARTIFACT_DIR"

if [[ "$BUILD_BACKEND" == "docker" ]]; then
  echo "[build-vfs] building in docker (${RUST_IMAGE}) mode=$MODE ..."
  CARGO_CMD="cargo build --manifest-path /workspace/src/vfs/Cargo.toml"
  if [[ "$MODE" == "release" ]]; then
    CARGO_CMD="${CARGO_CMD} --release"
  fi

  docker run --rm \
    -v "$ROOT_DIR":/workspace \
    -v "$HOME/.cargo/registry":/usr/local/cargo/registry \
    -v "$HOME/.cargo/git":/usr/local/cargo/git \
    -w /workspace \
    "$RUST_IMAGE" \
    bash -c "set -euo pipefail; \
      export PATH=/usr/local/cargo/bin:\$PATH; \
      if ! command -v protoc >/dev/null 2>&1; then \
        apt-get update && apt-get install -y --no-install-recommends protobuf-compiler libprotobuf-dev && rm -rf /var/lib/apt/lists/*; \
      fi; \
      /usr/local/cargo/bin/cargo --version >/dev/null; \
      $CARGO_CMD"
else
  echo "[build-vfs] building natively mode=$MODE ..."
  if [[ "$MODE" == "debug" ]]; then
    cargo build --manifest-path "$ROOT_DIR/src/vfs/Cargo.toml"
  else
    cargo build --manifest-path "$ROOT_DIR/src/vfs/Cargo.toml" --release
  fi
fi

if [[ "$MODE" == "debug" ]]; then
  SOURCE_BIN="$TARGET_DIR/debug/memory-vfs"
else
  SOURCE_BIN="$TARGET_DIR/release/memory-vfs"
fi

if [[ ! -x "$SOURCE_BIN" ]]; then
  echo "[build-vfs] binary not found: $SOURCE_BIN" >&2
  exit 1
fi

install -m 0755 "$SOURCE_BIN" "$ARTIFACT_PATH"
echo "[build-vfs] exported: $ARTIFACT_PATH (mode=$MODE backend=$BUILD_BACKEND)"
