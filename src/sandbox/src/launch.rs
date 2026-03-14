use std::io;

use crate::config::{BunMode, SandboxConfig};
use crate::mounts::build_mounts;
use crate::runtime::{CtrRuntime, DryRunRuntime, SandboxRuntime};
use crate::socket::{parse_uds_path, prepare_socket_mountpoint};
use crate::spec::build_spec;

pub fn run() -> io::Result<()> {
    let mut cfg = SandboxConfig::from_env();
    cfg.validate()?;

    std::fs::create_dir_all(&cfg.host_workspace_dir)?;
    std::fs::create_dir_all(&cfg.host_runtime_dir)?;
    std::fs::create_dir_all(&cfg.host_enclave_runtime_dir)?;

    let enclave_socket_path = parse_uds_path(&cfg.enclave_socket)?;
    let vfs_socket_path = parse_uds_path(&cfg.vfs_socket)?;

    prepare_socket_mountpoint(&enclave_socket_path)?;
    prepare_socket_mountpoint(&vfs_socket_path)?;

    // Keep sandbox socket wiring and enclave runtime bind address in sync.
    // Without this, sandboxd may mount/prepare one socket path while
    // enclave-runtime still binds to appconfig default path.
    let enclave_bind_addr = cfg.enclave_socket.clone();
    ensure_child_env(&mut cfg, "AGENT_ENCLAVE_BIND_ADDR", enclave_bind_addr);

    println!(
        "[sandbox] socket wiring enclave_listen={} vfs_listen={}",
        cfg.enclave_socket, cfg.vfs_socket
    );

    // 关键约束：在构建 OciSpec 前，把进程命令改写为“先装 bun，再启动主进程”。
    prepare_bun_bootstrap_before_spec(&mut cfg);
    let mounts = build_mounts(&cfg, enclave_socket_path, vfs_socket_path);
    for mount in &mounts {
        println!(
            "[sandbox] mount {} -> {} opts={:?}",
            mount.source.display(),
            mount.target.display(),
            mount.options
        );
    }
    let spec = build_spec(&cfg, mounts);

    if use_dry_run_runtime() {
        let runtime = DryRunRuntime;
        return runtime.run(&spec);
    }

    let runtime = CtrRuntime::new();
    runtime.run(&spec)
}

fn ensure_child_env(cfg: &mut SandboxConfig, key: &str, value: String) {
    if cfg.process_env.iter().any(|(existing, _)| existing == key) {
        return;
    }
    cfg.process_env.push((key.to_string(), value));
}

fn prepare_bun_bootstrap_before_spec(cfg: &mut SandboxConfig) {
    let app_cmd = cfg.process_args.iter().map(|arg| shell_escape(arg)).collect::<Vec<_>>().join(" ");
    let workdir = shell_escape(&cfg.process_cwd.to_string_lossy());
    let log_file = "/.runtime/sandbox-enclave.log";
    let bun_bin = shell_escape(&cfg.container_bun_bin.to_string_lossy());

    let bun_bootstrap = match cfg.bun_mode {
        BunMode::Mount => format!(
            "if ! command -v bun >/dev/null 2>&1; then \
  if [ -x {bun_bin} ]; then \
    export PATH=\"$(dirname {bun_bin}):$PATH\"; \
  fi; \
fi; \
if ! command -v bun >/dev/null 2>&1; then \
  echo \"[sandbox] bun not found in mount mode. Check SANDBOX_HOST_BUN_BIN/SANDBOX_CONTAINER_BUN_BIN.\"; \
  exit 1; \
fi;"
        ),
        BunMode::Install => "if ! command -v bun >/dev/null 2>&1; then \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl unzip; \
  ok=0; \
  for i in 1 2 3 4 5; do \
    if curl -fsSL --http1.1 --retry 3 --retry-all-errors https://bun.sh/install | bash; then \
      ok=1; \
      break; \
    fi; \
    echo \"[sandbox] bun install failed, retry $i/5\"; \
    sleep 2; \
  done; \
  if [ \"$ok\" -ne 1 ]; then \
    echo \"[sandbox] bun install failed after retries\"; \
    exit 1; \
  fi; \
fi; \
export BUN_INSTALL=\"${BUN_INSTALL:-/root/.bun}\"; \
export PATH=\"$BUN_INSTALL/bin:$PATH\";"
            .to_string(),
    };

    // 为了排查容器内启动失败，统一把启动日志落盘到挂载目录。
    let bootstrap = format!(
        "set -e; \
mkdir -p /.runtime; \
: > {log_file}; \
exec >{log_file} 2>&1; \
set -x; \
{bun_bootstrap} \
cd {workdir}; \
{app_cmd}"
    );

    cfg.process_args = vec!["/bin/sh".to_string(), "-lc".to_string(), bootstrap];
}

fn shell_escape(input: &str) -> String {
    let escaped = input.replace('\'', "'\"'\"'");
    format!("'{escaped}'")
}

fn use_dry_run_runtime() -> bool {
    match std::env::var("SANDBOX_DRY_RUN") {
        Ok(value) => {
            let lowered = value.trim().to_ascii_lowercase();
            lowered == "1" || lowered == "true" || lowered == "yes"
        }
        Err(_) => false,
    }
}
