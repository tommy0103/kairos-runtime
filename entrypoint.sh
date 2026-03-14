#!/bin/bash
set -euo pipefail
export PATH=/root/.bun/bin:$PATH

echo '[app] Starting bun install...'
bun install --frozen-lockfile || bun install

vfs_bin='/opt/artifacts/memory-vfs'
vfs_socket='/run/kairos-runtime/sockets/kairos-runtime-vfs.sock'

if [ ! -x "$vfs_bin" ]; then
  echo "[app] Error: missing vfs artifact at $vfs_bin"
  exit 1
fi

echo "[app] Starting memory-vfs with socket $vfs_socket..."
mkdir -p /run/kairos-runtime/sockets
rm -f "$vfs_socket"

export MEMORY_VFS_TARGET="$vfs_socket"
export KAIROS_VFS_SOCKET="$vfs_socket"

"$vfs_bin" &
vfs_pid=$!

for i in {1..30}; do
  if [ -S "$vfs_socket" ]; then
    echo '[app] memory-vfs ready'
    break
  fi
  if [ -S "/tmp/kairos-runtime-vfs.sock" ]; then
    echo '[app] memory-vfs started at legacy path /tmp/kairos-runtime-vfs.sock, linking...'
    ln -sf /tmp/kairos-runtime-vfs.sock "$vfs_socket"
    break
  fi
  if ! kill -0 $vfs_pid 2>/dev/null; then
    echo '[app] memory-vfs process died'
    exit 1
  fi
  sleep 1
done

echo '[app] Starting application...'
bun run dev
