use std::path::PathBuf;

use crate::config::{BunMode, SandboxConfig};

#[derive(Debug, Clone)]
pub struct BindMount {
    pub source: PathBuf,
    pub target: PathBuf,
    pub options: Vec<String>,
}

impl BindMount {
    fn rw_bind(source: PathBuf, target: PathBuf) -> Self {
        Self {
            source,
            target,
            options: vec![
                "rbind".to_string(),
                "rw".to_string(),
                "rprivate".to_string(),
            ],
        }
    }

    fn ro_bind(source: PathBuf, target: PathBuf) -> Self {
        Self {
            source,
            target,
            options: vec!["bind".to_string(), "ro".to_string()],
        }
    }

    fn rw_bind_shallow(source: PathBuf, target: PathBuf) -> Self {
        Self {
            source,
            target,
            options: vec!["bind".to_string(), "rw".to_string(), "rprivate".to_string()],
        }
    }
}

pub fn build_mounts(
    cfg: &SandboxConfig,
    enclave_socket_path: PathBuf,
    vfs_socket_path: PathBuf,
) -> Vec<BindMount> {
    let mut mounts = vec![
        BindMount::rw_bind(
            cfg.host_workspace_dir.clone(),
            cfg.container_workspace_dir.clone(),
        ),
        BindMount::rw_bind(cfg.host_runtime_dir.clone(), cfg.container_runtime_dir.clone()),
        BindMount::rw_bind(
            cfg.host_enclave_runtime_dir.clone(),
            cfg.container_enclave_dir.clone(),
        ),
    ];

    let mut socket_parent_mounts: Vec<(PathBuf, PathBuf)> = Vec::new();
    for socket_path in [&enclave_socket_path, &vfs_socket_path] {
        if let Some(parent) = socket_path.parent() {
            // For socket directories, prefer shallow bind instead of rbind.
            // This avoids recursively pulling nested mounts from host /tmp into the sandbox.
            let source = parent.to_path_buf();
            let target = parent.to_path_buf();
            if !socket_parent_mounts
                .iter()
                .any(|(existing_source, existing_target)| {
                    existing_source == &source && existing_target == &target
                })
            {
                socket_parent_mounts.push((source, target));
            }
        }
    }
    for (source, target) in socket_parent_mounts {
        mounts.push(BindMount::rw_bind_shallow(source, target));
    }

    if cfg.bun_mode == BunMode::Mount {
        if let Some(host_bun_bin) = &cfg.host_bun_bin {
            mounts.push(BindMount::ro_bind(
                host_bun_bin.clone(),
                cfg.container_bun_bin.clone(),
            ));
        }
    }

    mounts
}
