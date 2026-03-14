use std::io;
use std::path::{Path, PathBuf};

pub fn parse_uds_path(addr: &str) -> io::Result<PathBuf> {
    if let Some(path) = addr.strip_prefix("unix://") {
        if path.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unix address path is empty",
            ));
        }
        return Ok(PathBuf::from(path));
    }

    if let Some(path) = addr.strip_prefix("unix:") {
        if path.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unix address path is empty",
            ));
        }
        return Ok(PathBuf::from(path));
    }

    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("unsupported socket address: {addr}"),
    ))
}

pub fn prepare_socket_mountpoint(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    match std::fs::remove_file(path) {
        Ok(_) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }

    // Do not pre-create socket file.
    // The producer process (inside or outside container) should create it by bind/listen.
    Ok(())
}
