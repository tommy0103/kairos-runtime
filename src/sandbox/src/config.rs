use std::env;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone)]
pub struct SandboxConfig {
    pub namespace: String,
    pub container_id: String,
    pub snapshot_key: String,
    pub snapshot_parent: Option<String>,
    pub image: String,
    pub enclave_socket: String,
    pub vfs_socket: String,
    pub host_workspace_dir: PathBuf,
    pub host_runtime_dir: PathBuf,
    pub host_enclave_runtime_dir: PathBuf,
    pub host_bun_bin: Option<PathBuf>,
    pub bun_mode: BunMode,
    pub container_workspace_dir: PathBuf,
    pub container_runtime_dir: PathBuf,
    pub container_enclave_dir: PathBuf,
    pub container_bun_bin: PathBuf,
    pub process_cwd: PathBuf,
    pub process_args: Vec<String>,
    pub process_env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BunMode {
    Mount,
    Install,
}

impl SandboxConfig {
    pub fn from_env() -> Self {
        load_repo_env_file();
        let project_root = resolve_project_root();

        let host_runtime_dir =
            resolve_path_from_env("SANDBOX_HOST_RUNTIME_DIR", &project_root.join(".runtime"));
        let host_enclave_runtime_dir = resolve_path_from_env(
            "SANDBOX_HOST_ENCLAVE_RUNTIME_DIR",
            &project_root.join("src/enclave-runtime"),
        );
        let host_bun_bin = resolve_optional_path_from_env("SANDBOX_HOST_BUN_BIN");
        let host_workspace_dir =
            resolve_path_from_env("SANDBOX_HOST_WORKSPACE_DIR", &project_root);

        Self {
            namespace: env::var("SANDBOX_NAMESPACE").unwrap_or_else(|_| "default".to_string()),
            container_id: env::var("SANDBOX_CONTAINER_ID")
                .unwrap_or_else(|_| "kairos-enclave-sandbox".to_string()),
            snapshot_key: env::var("SANDBOX_SNAPSHOT_KEY")
                .unwrap_or_else(|_| "kairos-enclave-snapshot".to_string()),
            snapshot_parent: resolve_optional_env("SANDBOX_SNAPSHOT_PARENT"),
            image: resolve_image(),
            enclave_socket: env::var("ENCLAVE_LISTEN")
                .or_else(|_| env::var("KAIROS_ENCLAVE_SOCKET"))
                .unwrap_or_else(|_| {
                    "unix:///run/kairos-runtime/sockets/kairos-runtime-enclave.sock".to_string()
                }),
            vfs_socket: env::var("VFS_LISTEN")
                .or_else(|_| env::var("KAIROS_VFS_SOCKET"))
                .unwrap_or_else(|_| {
                    "unix:///run/kairos-runtime/sockets/kairos-runtime-vfs.sock".to_string()
                }),
            host_workspace_dir,
            host_runtime_dir,
            host_enclave_runtime_dir,
            host_bun_bin,
            bun_mode: resolve_bun_mode(),
            container_workspace_dir: resolve_container_path_from_env(
                "SANDBOX_CONTAINER_WORKSPACE_DIR",
                Path::new("/workspace"),
            ),
            container_runtime_dir: resolve_container_path_from_env(
                "SANDBOX_CONTAINER_RUNTIME_DIR",
                Path::new("/.runtime"),
            ),
            container_enclave_dir: resolve_container_path_from_env(
                "SANDBOX_CONTAINER_ENCLAVE_DIR",
                Path::new("/enclave"),
            ),
            container_bun_bin: resolve_container_path_from_env(
                "SANDBOX_CONTAINER_BUN_BIN",
                Path::new("/usr/local/bin/bun"),
            ),
            process_cwd: resolve_container_path_from_env(
                "SANDBOX_PROCESS_CWD",
                Path::new("/workspace/src/enclave-runtime"),
            ),
            process_args: resolve_process_args(),
            process_env: resolve_process_env(),
        }
    }

    pub fn validate(&self) -> io::Result<()> {
        let image = self.image.trim();
        if image != "debian:slim"
            && image != "debian:bookworm-slim"
            && image != "docker.io/library/debian:slim"
            && image != "docker.io/library/debian:bookworm-slim"
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "sandbox image must be debian:slim (or bookworm-slim variant), got {}",
                    image
                ),
            ));
        }

        if self.process_args.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "sandbox process args must not be empty",
            ));
        }

        if !self.container_runtime_dir.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "SANDBOX_CONTAINER_RUNTIME_DIR must be absolute, got {}",
                    self.container_runtime_dir.display()
                ),
            ));
        }
        if !self.container_workspace_dir.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "SANDBOX_CONTAINER_WORKSPACE_DIR must be absolute, got {}",
                    self.container_workspace_dir.display()
                ),
            ));
        }
        if !self.container_enclave_dir.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "SANDBOX_CONTAINER_ENCLAVE_DIR must be absolute, got {}",
                    self.container_enclave_dir.display()
                ),
            ));
        }
        if !self.process_cwd.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "SANDBOX_PROCESS_CWD must be absolute, got {}",
                    self.process_cwd.display()
                ),
            ));
        }
        if !self.container_bun_bin.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "SANDBOX_CONTAINER_BUN_BIN must be absolute, got {}",
                    self.container_bun_bin.display()
                ),
            ));
        }
        match self.bun_mode {
            BunMode::Mount => {
                let host_bun_bin = self.host_bun_bin.as_ref().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "SANDBOX_BUN_MODE=mount requires SANDBOX_HOST_BUN_BIN",
                    )
                })?;
                if !host_bun_bin.exists() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!(
                            "SANDBOX_HOST_BUN_BIN does not exist: {}",
                            host_bun_bin.display()
                        ),
                    ));
                }
            }
            BunMode::Install => {}
        }

        Ok(())
    }
}

fn load_repo_env_file() {
    let env_path = resolve_project_root().join(".env");
    let _ = dotenvy::from_path(env_path);
}

fn resolve_project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

fn resolve_path_from_env(name: &str, default_value: &Path) -> PathBuf {
    env::var(name)
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_value.to_path_buf())
}

fn resolve_container_path_from_env(name: &str, default_value: &Path) -> PathBuf {
    let path = resolve_path_from_env(name, default_value);
    if path.is_absolute() {
        return path;
    }

    let mut absolute = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => absolute.push(part),
            _ => {}
        }
    }
    absolute
}

fn resolve_process_args() -> Vec<String> {
    if let Ok(raw) = env::var("SANDBOX_PROCESS_ARGS") {
        let args: Vec<String> = raw
            .split_whitespace()
            .filter(|segment| !segment.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        if !args.is_empty() {
            return args;
        }
    }

    vec!["bun".to_string(), "run".to_string(), "dev".to_string()]
}

fn resolve_process_env() -> Vec<(String, String)> {
    let mut vars = Vec::new();
    for (key, value) in env::vars() {
        if key.starts_with("SANDBOX_CHILD_ENV_") {
            let env_key = key.trim_start_matches("SANDBOX_CHILD_ENV_").to_string();
            if !env_key.is_empty() {
                vars.push((env_key, value));
            }
        }
    }
    vars.sort_by(|a, b| a.0.cmp(&b.0));
    vars
}

fn resolve_image() -> String {
    if let Ok(image) = env::var("SANDBOX_IMAGE") {
        if !image.trim().is_empty() {
            return image;
        }
    }

    if let Ok(image) = env::var("SANDBOX_ROOTFS") {
        if !image.trim().is_empty() {
            return image;
        }
    }

    "debian:slim".to_string()
}

fn resolve_optional_env(name: &str) -> Option<String> {
    match env::var(name) {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Err(_) => None,
    }
}

fn resolve_optional_path_from_env(name: &str) -> Option<PathBuf> {
    resolve_optional_env(name).map(PathBuf::from)
}

fn resolve_bun_mode() -> BunMode {
    match env::var("SANDBOX_BUN_MODE") {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "mount" => BunMode::Mount,
            "install" => BunMode::Install,
            _ => BunMode::Mount,
        },
        Err(_) => BunMode::Mount,
    }
}
