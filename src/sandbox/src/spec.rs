use std::path::PathBuf;

use crate::config::SandboxConfig;
use crate::mounts::BindMount;

#[derive(Debug, Clone)]
pub struct ProcessSpec {
    pub cwd: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct OciSpecDraft {
    pub namespace: String,
    pub container_id: String,
    pub snapshot_key: String,
    pub snapshot_parent: Option<String>,
    pub image: String,
    pub process: ProcessSpec,
    pub mounts: Vec<BindMount>,
}

pub fn build_spec(cfg: &SandboxConfig, mounts: Vec<BindMount>) -> OciSpecDraft {
    OciSpecDraft {
        namespace: cfg.namespace.clone(),
        container_id: cfg.container_id.clone(),
        snapshot_key: cfg.snapshot_key.clone(),
        snapshot_parent: cfg.snapshot_parent.clone(),
        image: cfg.image.clone(),
        process: ProcessSpec {
            cwd: cfg.process_cwd.clone(),
            args: cfg.process_args.clone(),
            env: cfg.process_env.clone(),
        },
        mounts,
    }
}
