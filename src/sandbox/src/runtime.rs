use std::io;
use std::path::PathBuf;
use std::time::Duration;

use containerd_client::services::v1::containers_client::ContainersClient;
use containerd_client::services::v1::snapshots::snapshots_client::SnapshotsClient;
use containerd_client::services::v1::tasks_client::TasksClient;
use containerd_client::services::v1::{
    Container, CreateContainerRequest, CreateTaskRequest, DeleteContainerRequest, DeleteTaskRequest,
    GetImageRequest, KillRequest, StartRequest, TransferRequest, WaitRequest,
};
use containerd_client::to_any;
use containerd_client::types::transfer::{ImageStore, OciRegistry, UnpackConfiguration};
use containerd_client::types::{Mount, Platform};
use containerd_client::{
    Client,
    tonic::{Code, Request},
    with_namespace,
};
use prost_types::Any;
use tokio::runtime::Builder;

use crate::mounts::BindMount;
use crate::spec::OciSpecDraft;

pub trait SandboxRuntime {
    fn run(&self, spec: &OciSpecDraft) -> io::Result<()>;
}

pub struct DryRunRuntime;

impl SandboxRuntime for DryRunRuntime {
    fn run(&self, spec: &OciSpecDraft) -> io::Result<()> {
        println!(
            "[sandbox] dry-run start namespace={} container_id={} snapshot_key={} image={}",
            spec.namespace, spec.container_id, spec.snapshot_key, spec.image
        );
        println!(
            "[sandbox] process cwd={} args={:?}",
            spec.process.cwd.display(),
            spec.process.args
        );
        for (key, value) in &spec.process.env {
            println!("[sandbox] process env {key}={value}");
        }
        for mount in &spec.mounts {
            println!(
                "[sandbox] mount {} -> {} opts={:?}",
                mount.source.display(),
                mount.target.display(),
                mount.options
            );
        }
        println!("[sandbox] dry-run finished");
        Ok(())
    }
}

pub struct CtrRuntime {
    containerd_socket: String,
    snapshotter: String,
    runtime_name: String,
}

impl CtrRuntime {
    pub fn new() -> Self {
        Self {
            containerd_socket: "/run/containerd/containerd.sock".to_string(),
            snapshotter: "overlayfs".to_string(),
            runtime_name: "io.containerd.runc.v2".to_string(),
        }
    }
}

impl SandboxRuntime for CtrRuntime {
    fn run(&self, spec: &OciSpecDraft) -> io::Result<()> {
        let rt = Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|err| io::Error::other(format!("tokio runtime init failed: {err}")))?;
        rt.block_on(self.run_async(spec))
    }
}

impl CtrRuntime {
    async fn run_async(&self, spec: &OciSpecDraft) -> io::Result<()> {
        println!(
            "[sandbox] containerd-client runtime start namespace={} container_id={} snapshot_key={} image={}",
            spec.namespace, spec.container_id, spec.snapshot_key, spec.image
        );

        let client = Client::from_path(&self.containerd_socket)
            .await
            .map_err(|err| {
                let message = format!("{err}");
                let hint = if message.contains("permission denied") {
                    " (permission denied; try running sandboxd with sudo, or grant your user access to containerd.sock)"
                } else {
                    ""
                };
                io::Error::other(format!(
                    "connect containerd socket '{}' failed: {}{} (debug: {:?})",
                    self.containerd_socket, message, hint, err
                ))
            })?;

        // 启动前只清理 task/container 残留，不删除 snapshot。
        // 否则会把外部预先 prepare 的 snapshot_key 误删。
        self.cleanup_best_effort(&client, spec, true, false).await;
        let image = self.resolve_image(&client, spec).await?;
        self.ensure_snapshot_ready(&client, spec, &image).await?;

        let mut containers_client = client.containers();
        let container = Container {
            id: spec.container_id.clone(),
            labels: Default::default(),
            image: image.reference,
            runtime: Some(containerd_client::services::v1::container::Runtime {
                name: self.runtime_name.clone(),
                options: None,
            }),
            spec: Some(Any {
                type_url: "types.containerd.io/opencontainers/runtime-spec/1/Spec".to_string(),
                value: serde_json::to_vec(&build_oci_spec(spec))
                    .map_err(|err| io::Error::other(format!("serialize oci spec failed: {err}")))?,
            }),
            snapshotter: self.snapshotter.clone(),
            snapshot_key: spec.snapshot_key.clone(),
            created_at: None,
            updated_at: None,
            extensions: Default::default(),
            sandbox: String::new(),
        };

        containers_client
            .create(with_namespace!(
                CreateContainerRequest {
                    container: Some(container)
                },
                &spec.namespace
            ))
            .await
            .map_err(to_io_err("create container"))?;

        let rootfs = self.fetch_snapshot_mounts(&client, spec).await?;
        let mut tasks_client = client.tasks();
        tasks_client
            .create(with_namespace!(
                CreateTaskRequest {
                    container_id: spec.container_id.clone(),
                    rootfs,
                    stdin: String::new(),
                    stdout: String::new(),
                    stderr: String::new(),
                    terminal: false,
                    checkpoint: None,
                    options: None,
                    runtime_path: String::new(),
                },
                &spec.namespace
            ))
            .await
            .map_err(to_io_err("create task"))?;

        tasks_client
            .start(with_namespace!(
                StartRequest {
                    container_id: spec.container_id.clone(),
                    exec_id: String::new(),
                },
                &spec.namespace
            ))
            .await
            .map_err(to_io_err("start task"))?;

        self.probe_enclave_socket_visibility(spec).await;

        let wait_response = tasks_client
            .wait(with_namespace!(
                WaitRequest {
                    container_id: spec.container_id.clone(),
                    exec_id: String::new(),
                },
                &spec.namespace
            ))
            .await
            .map_err(to_io_err("wait task"))?
            .into_inner();

        if wait_response.exit_status != 0 {
            self.cleanup_best_effort(&client, spec, true, true).await;
            return Err(io::Error::other(format!(
                "container task exited with non-zero status: {}. check runtime log at /.runtime/sandbox-enclave.log (host-mounted .runtime directory)",
                wait_response.exit_status
            )));
        }

        self.cleanup_best_effort(&client, spec, false, true).await;
        println!("[sandbox] containerd-client runtime finished");
        Ok(())
    }

    async fn probe_enclave_socket_visibility(&self, spec: &OciSpecDraft) {
        let Some(bind_addr) = get_process_env(spec, "AGENT_ENCLAVE_BIND_ADDR") else {
            return;
        };
        let Some(socket_path) = parse_unix_addr_to_path(&bind_addr) else {
            return;
        };

        let max_attempts = 50;
        let sleep_ms = 100;
        for _ in 0..max_attempts {
            if std::fs::metadata(&socket_path).is_ok() {
                println!(
                    "[sandbox] enclave socket visible on host: {}",
                    socket_path.display()
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
        }
        eprintln!(
            "[sandbox] warning: enclave socket not visible on host after start: {} (bind_addr={})",
            socket_path.display(),
            bind_addr
        );
    }

    async fn resolve_image(&self, client: &Client, spec: &OciSpecDraft) -> io::Result<ResolvedImage> {
        let candidates = image_ref_candidates(&spec.image);
        if let Some(image) = self.resolve_image_from_candidates(client, spec, &candidates).await? {
            return Ok(image);
        }

        let bootstrap_ref = candidates
            .last()
            .cloned()
            .unwrap_or_else(|| spec.image.clone());
        self.bootstrap_image(client, spec, &bootstrap_ref).await?;

        if let Some(image) = self.resolve_image_from_candidates(client, spec, &candidates).await? {
            return Ok(image);
        }

        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "image '{}' not found in containerd namespace '{}' after bootstrap",
                spec.image, spec.namespace
            ),
        ))
    }

    async fn ensure_snapshot_ready(
        &self,
        client: &Client,
        spec: &OciSpecDraft,
        image: &ResolvedImage,
    ) -> io::Result<()> {
        let mut snapshots_client: SnapshotsClient<_> = client.snapshots();
        let mounts_request = || {
            with_namespace!(
                containerd_client::services::v1::snapshots::MountsRequest {
                    snapshotter: self.snapshotter.clone(),
                    key: spec.snapshot_key.clone(),
                },
                &spec.namespace
            )
        };

        match snapshots_client.mounts(mounts_request()).await {
            Ok(_) => return Ok(()),
            Err(status) if status.code() == Code::NotFound => {}
            Err(status) => {
                return Err(io::Error::other(format!(
                    "check snapshot '{}' failed: {status}",
                    spec.snapshot_key
                )));
            }
        }

        let parent = image.parent_snapshot.clone().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "missing snapshot parent")
        });
        let parent = match parent {
            Ok(parent) => parent,
            Err(_) => self.resolve_snapshot_parent_fallback(client, spec, image).await?,
        };

        let prepare_result = snapshots_client
            .prepare(with_namespace!(
                containerd_client::services::v1::snapshots::PrepareSnapshotRequest {
                    snapshotter: self.snapshotter.clone(),
                    key: spec.snapshot_key.clone(),
                    parent,
                    labels: Default::default(),
                },
                &spec.namespace
            ))
            .await;

        match prepare_result {
            Ok(_) => {}
            Err(status) if status.code() == Code::AlreadyExists => {}
            Err(status) => {
                return Err(io::Error::other(format!(
                    "prepare snapshot '{}' failed: {status}",
                    spec.snapshot_key
                )));
            }
        }

        snapshots_client
            .mounts(mounts_request())
            .await
            .map_err(to_io_err("verify snapshot mounts after prepare"))?;
        Ok(())
    }

    async fn resolve_snapshot_parent_fallback(
        &self,
        client: &Client,
        spec: &OciSpecDraft,
        image: &ResolvedImage,
    ) -> io::Result<String> {
        if let Some(configured_parent) = &spec.snapshot_parent {
            return Ok(configured_parent.clone());
        }

        // Try auto-bootstrap once to force unpack labels for this snapshotter.
        self.bootstrap_image(client, spec, &image.reference).await?;
        if let Some(metadata) = self.read_image_metadata(client, spec, &image.reference).await? {
            if let Some(parent) = metadata.parent_snapshot {
                return Ok(parent);
            }
            if let Some(parent) = self
                .resolve_parent_from_single_layer_digest(client, spec, &metadata.layer_content_digests)
                .await?
            {
                return Ok(parent);
            }
        } else if let Some(parent) = self
            .resolve_parent_from_single_layer_digest(client, spec, &image.layer_content_digests)
            .await?
        {
            return Ok(parent);
        }

        if let Some(parent) = self
            .resolve_parent_from_unique_committed_snapshot(client, spec)
            .await?
        {
            eprintln!(
                "[sandbox] warning: image '{}' has no snapshot parent metadata; using unique committed snapshot '{}' as fallback",
                image.reference, parent
            );
            return Ok(parent);
        }

        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "snapshot '{}' does not exist and image '{}' has no snapshot parent metadata for snapshotter '{}'. \
Set SANDBOX_SNAPSHOT_PARENT explicitly, or ensure image is unpacked for this snapshotter \
(e.g. sudo ctr -n {} images pull --snapshotter {} {}).",
                spec.snapshot_key, image.reference, self.snapshotter, spec.namespace, self.snapshotter, image.reference
            ),
        ))
    }

    async fn resolve_parent_from_unique_committed_snapshot(
        &self,
        client: &Client,
        spec: &OciSpecDraft,
    ) -> io::Result<Option<String>> {
        let mut snapshots_client: SnapshotsClient<_> = client.snapshots();
        let mut stream = snapshots_client
            .list(with_namespace!(
                containerd_client::services::v1::snapshots::ListSnapshotsRequest {
                    snapshotter: self.snapshotter.clone(),
                    filters: Vec::new(),
                },
                &spec.namespace
            ))
            .await
            .map_err(to_io_err("list snapshots for fallback"))?
            .into_inner();

        let mut committed = Vec::new();
        while let Some(chunk) = stream
            .message()
            .await
            .map_err(to_io_err("read snapshots list stream"))?
        {
            for info in chunk.info {
                if info.kind == 3 {
                    committed.push(info.name);
                }
            }
        }

        if committed.len() == 1 {
            return Ok(committed.into_iter().next());
        }
        Ok(None)
    }

    async fn resolve_image_from_candidates(
        &self,
        client: &Client,
        spec: &OciSpecDraft,
        candidates: &[String],
    ) -> io::Result<Option<ResolvedImage>> {
        for candidate in candidates {
            if let Some(metadata) = self.read_image_metadata(client, spec, candidate).await? {
                return Ok(Some(ResolvedImage {
                    reference: candidate.clone(),
                    parent_snapshot: metadata.parent_snapshot,
                    layer_content_digests: metadata.layer_content_digests,
                }));
            }
        }
        Ok(None)
    }

    async fn read_image_metadata(
        &self,
        client: &Client,
        spec: &OciSpecDraft,
        image_ref: &str,
    ) -> io::Result<Option<ImageMetadata>> {
        let mut images_client = client.images();
        let snapshot_parent_label = format!("containerd.io/gc.ref.snapshot.{}", self.snapshotter);
        match images_client
            .get(with_namespace!(
                GetImageRequest {
                    name: image_ref.to_string(),
                },
                &spec.namespace
            ))
            .await
        {
            Ok(response) => {
                let labels = response
                    .into_inner()
                    .image
                    .map(|image| image.labels)
                    .unwrap_or_default();
                let parent_snapshot = labels.get(&snapshot_parent_label).cloned();

                let mut layer_entries: Vec<(usize, String)> = labels
                    .iter()
                    .filter_map(|(key, value)| {
                        let suffix = key.strip_prefix("containerd.io/gc.ref.content.l.")?;
                        let idx = suffix.parse::<usize>().ok()?;
                        Some((idx, value.clone()))
                    })
                    .collect();
                layer_entries.sort_by_key(|(idx, _)| *idx);
                let layer_content_digests = layer_entries.into_iter().map(|(_, d)| d).collect();

                Ok(Some(ImageMetadata {
                    parent_snapshot,
                    layer_content_digests,
                }))
            }
            Err(status) if status.code() == Code::NotFound => Ok(None),
            Err(status) => Err(io::Error::other(format!(
                "read image '{}' metadata failed: {status}",
                image_ref
            ))),
        }
    }

    async fn resolve_parent_from_single_layer_digest(
        &self,
        client: &Client,
        spec: &OciSpecDraft,
        layer_content_digests: &[String],
    ) -> io::Result<Option<String>> {
        if layer_content_digests.len() != 1 {
            return Ok(None);
        }
        let candidate = layer_content_digests[0].clone();
        let mut snapshots_client: SnapshotsClient<_> = client.snapshots();
        let stat = snapshots_client
            .stat(with_namespace!(
                containerd_client::services::v1::snapshots::StatSnapshotRequest {
                    snapshotter: self.snapshotter.clone(),
                    key: candidate.clone(),
                },
                &spec.namespace
            ))
            .await;
        match stat {
            Ok(response) => {
                if let Some(info) = response.into_inner().info {
                    if info.kind == 3 {
                        return Ok(Some(candidate));
                    }
                }
                Ok(None)
            }
            Err(status) if status.code() == Code::NotFound => Ok(None),
            Err(status) => Err(io::Error::other(format!(
                "stat snapshot parent candidate '{}' failed: {status}",
                candidate
            ))),
        }
    }

    async fn bootstrap_image(
        &self,
        client: &Client,
        spec: &OciSpecDraft,
        image_ref: &str,
    ) -> io::Result<()> {
        let mut transfer_client = client.transfer();
        let candidates = transfer_image_ref_candidates(image_ref);
        let mut retriable_refs: Vec<String> = Vec::new();
        let platform = resolve_transfer_platform();

        for candidate in candidates {
            let result = transfer_client
                .transfer(with_namespace!(
                    TransferRequest {
                        source: Some(to_any(&OciRegistry {
                            reference: candidate.clone(),
                            resolver: None,
                        })),
                        destination: Some(to_any(&ImageStore {
                            name: candidate.clone(),
                            labels: Default::default(),
                            platforms: vec![platform.clone()],
                            all_metadata: false,
                            manifest_limit: 0,
                            extra_references: Vec::new(),
                            unpacks: vec![UnpackConfiguration {
                                platform: Some(platform.clone()),
                                snapshotter: self.snapshotter.clone(),
                            }],
                        })),
                        options: None,
                    },
                    &spec.namespace
                ))
                .await;

            match result {
                Ok(_) => return Ok(()),
                Err(status) if status.code() == Code::NotFound => {
                    retriable_refs.push(candidate);
                }
                Err(status)
                    if status.code() == Code::Unknown
                        && status
                            .message()
                            .contains("invalid port") =>
                {
                    retriable_refs.push(candidate);
                }
                Err(status) => {
                    return Err(io::Error::other(format!(
                        "bootstrap image via transfer API failed: {status}"
                    )));
                }
            }
        }

        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "bootstrap image via transfer API failed: no resolvable candidate succeeded: {}",
                retriable_refs.join(", ")
            ),
        ))
    }

    async fn fetch_snapshot_mounts(
        &self,
        client: &Client,
        spec: &OciSpecDraft,
    ) -> io::Result<Vec<Mount>> {
        let mut snapshots_client: SnapshotsClient<_> = client.snapshots();
        let response = snapshots_client
            .mounts(with_namespace!(
                containerd_client::services::v1::snapshots::MountsRequest {
                    snapshotter: self.snapshotter.clone(),
                    key: spec.snapshot_key.clone(),
                },
                &spec.namespace
            ))
            .await
            .map_err(to_io_err("fetch snapshot mounts"))?;
        Ok(response.into_inner().mounts)
    }

    async fn cleanup_best_effort(
        &self,
        client: &Client,
        spec: &OciSpecDraft,
        kill_before_delete: bool,
        remove_snapshot: bool,
    ) {
        let mut tasks_client: TasksClient<_> = client.tasks();
        if kill_before_delete {
            let _ = tasks_client
                .kill(with_namespace!(
                    KillRequest {
                        container_id: spec.container_id.clone(),
                        exec_id: String::new(),
                        signal: 9,
                        all: true,
                    },
                    &spec.namespace
                ))
                .await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        let _ = tasks_client
            .delete(with_namespace!(
                DeleteTaskRequest {
                    container_id: spec.container_id.clone(),
                },
                &spec.namespace
            ))
            .await;

        let mut containers_client: ContainersClient<_> = client.containers();
        let _ = containers_client
            .delete(with_namespace!(
                DeleteContainerRequest {
                    id: spec.container_id.clone(),
                },
                &spec.namespace
            ))
            .await;

        if remove_snapshot {
            let mut snapshots_client: SnapshotsClient<_> = client.snapshots();
            let _ = snapshots_client
                .remove(with_namespace!(
                    containerd_client::services::v1::snapshots::RemoveSnapshotRequest {
                        snapshotter: self.snapshotter.clone(),
                        key: spec.snapshot_key.clone(),
                    },
                    &spec.namespace
                ))
                .await;
        }
    }
}

fn build_oci_spec(spec: &OciSpecDraft) -> serde_json::Value {
    let process_env = spec
        .process
        .env
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>();

    // Mount ordering matters: place system mounts first, then user bind mounts.
    // Otherwise a later `/run` tmpfs mount can shadow `/run/...` bind targets.
    let mut mounts = default_oci_system_mounts();
    mounts.extend(spec.mounts.iter().map(bind_mount_to_json));

    serde_json::json!({
        "ociVersion": "1.0.2",
        "process": {
            "terminal": false,
            "cwd": spec.process.cwd,
            "args": spec.process.args,
            "env": process_env
        },
        "root": {
            "path": "rootfs",
            "readonly": false
        },
        "mounts": mounts
    })
}

fn default_oci_system_mounts() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "destination": "/proc",
            "type": "proc",
            "source": "proc",
            "options": ["nosuid", "noexec", "nodev"]
        }),
        serde_json::json!({
            "destination": "/dev",
            "type": "tmpfs",
            "source": "tmpfs",
            "options": ["nosuid", "strictatime", "mode=755", "size=65536k"]
        }),
        serde_json::json!({
            "destination": "/dev/pts",
            "type": "devpts",
            "source": "devpts",
            "options": ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620", "gid=5"]
        }),
        serde_json::json!({
            "destination": "/dev/shm",
            "type": "tmpfs",
            "source": "shm",
            "options": ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"]
        }),
        serde_json::json!({
            "destination": "/dev/mqueue",
            "type": "mqueue",
            "source": "mqueue",
            "options": ["nosuid", "noexec", "nodev"]
        }),
        serde_json::json!({
            "destination": "/sys",
            "type": "sysfs",
            "source": "sysfs",
            "options": ["nosuid", "noexec", "nodev", "ro"]
        }),
        serde_json::json!({
            "destination": "/run",
            "type": "tmpfs",
            "source": "tmpfs",
            "options": ["nosuid", "nodev", "mode=755", "size=65536k"]
        }),
    ]
}

fn bind_mount_to_json(mount: &BindMount) -> serde_json::Value {
    serde_json::json!({
        "destination": mount.target,
        "type": "bind",
        "source": mount.source,
        "options": mount.options
    })
}

fn to_io_err(
    context: &'static str,
) -> impl FnOnce(containerd_client::tonic::Status) -> io::Error {
    move |err| io::Error::other(format!("{context} failed: {err}"))
}

fn image_ref_candidates(image: &str) -> Vec<String> {
    let trimmed = image.trim();
    if trimmed.is_empty() {
        return vec![image.to_string()];
    }

    let mut refs = vec![trimmed.to_string()];
    let has_registry_or_namespace = trimmed.contains('/');
    if !has_registry_or_namespace {
        refs.push(format!("docker.io/library/{trimmed}"));
    } else if !trimmed.starts_with("docker.io/") && !trimmed.starts_with("registry-1.docker.io/") {
        refs.push(format!("docker.io/{trimmed}"));
    }

    // Debian's "slim" tag may not be resolvable in all registries; prefer bookworm-slim fallback.
    if trimmed == "debian:slim" {
        refs.push("debian:bookworm-slim".to_string());
        refs.push("docker.io/library/debian:bookworm-slim".to_string());
    } else if trimmed == "docker.io/library/debian:slim" {
        refs.push("docker.io/library/debian:bookworm-slim".to_string());
    }

    dedup_preserve_order(refs)
}

fn transfer_image_ref_candidates(image: &str) -> Vec<String> {
    let trimmed = image.trim();
    if trimmed.is_empty() {
        return vec![];
    }

    // transfer API requires registry-style references.
    if trimmed == "debian:slim" || trimmed == "docker.io/library/debian:slim" {
        return vec![
            "docker.io/library/debian:bookworm-slim".to_string(),
            "docker.io/library/debian:slim".to_string(),
        ];
    }

    if let Some(rest) = trimmed.strip_prefix("docker.io/") {
        return dedup_preserve_order(vec![format!("docker.io/{rest}")]);
    }

    if trimmed.contains('/') {
        return dedup_preserve_order(vec![trimmed.to_string()]);
    }

    dedup_preserve_order(vec![format!("docker.io/library/{trimmed}")])
}

#[derive(Debug, Clone)]
struct ResolvedImage {
    reference: String,
    parent_snapshot: Option<String>,
    layer_content_digests: Vec<String>,
}

#[derive(Debug, Clone)]
struct ImageMetadata {
    parent_snapshot: Option<String>,
    layer_content_digests: Vec<String>,
}

fn dedup_preserve_order(items: Vec<String>) -> Vec<String> {
    let mut deduped = Vec::new();
    for item in items {
        if !deduped.iter().any(|existing| existing == &item) {
            deduped.push(item);
        }
    }
    deduped
}

fn resolve_transfer_platform() -> Platform {
    // containerd transfer unpack requires explicit platform in many environments.
    let os = std::env::var("SANDBOX_IMAGE_OS").unwrap_or_else(|_| "linux".to_string());
    let arch = std::env::var("SANDBOX_IMAGE_ARCH").unwrap_or_else(|_| "amd64".to_string());
    let variant = std::env::var("SANDBOX_IMAGE_VARIANT").unwrap_or_default();
    Platform {
        os,
        architecture: arch,
        variant,
        os_version: String::new(),
    }
}

fn get_process_env(spec: &OciSpecDraft, key: &str) -> Option<String> {
    spec.process
        .env
        .iter()
        .find_map(|(k, v)| if k == key { Some(v.clone()) } else { None })
}

fn parse_unix_addr_to_path(addr: &str) -> Option<PathBuf> {
    if let Some(path) = addr.strip_prefix("unix://") {
        if path.is_empty() {
            return None;
        }
        return Some(PathBuf::from(path));
    }
    if let Some(path) = addr.strip_prefix("unix:") {
        if path.is_empty() {
            return None;
        }
        return Some(PathBuf::from(path));
    }
    None
}
