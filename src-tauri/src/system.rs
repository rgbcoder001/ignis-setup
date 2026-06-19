// src-tauri/src/system.rs — OS/hardware detection
use serde::{Deserialize, Serialize};
use crate::types::run_cmd;

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct SystemInfo {
    pub cpu_model:    String,
    pub cpu_cores:    String,
    pub gpu_model:    String,
    pub gpu_vendor:   String,   // "amd" | "nvidia" | "intel" | "unknown"
    pub ram_total_gb: String,
    pub os_name:      String,
    pub os_version:   String,
    pub os_id:        String,
    pub os_family:    String,   // "fedora-atomic" | "arch" | "steamos" | "debian" | "fedora" | "unknown"
    pub pkg_manager:  String,
    pub kernel:       String,
    pub desktop:      String,
    pub session_type: String,
    pub disk_info:    Vec<String>,
}

#[tauri::command]
pub fn get_system_info() -> SystemInfo {
    let mut info = SystemInfo::default();

    if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
        let mut id = String::new();
        let mut id_like = String::new();
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with("PRETTY_NAME=") {
                info.os_name = line.trim_start_matches("PRETTY_NAME=").trim_matches('"').to_string();
            } else if line.starts_with("VERSION_ID=") {
                info.os_version = line.trim_start_matches("VERSION_ID=").trim_matches('"').to_string();
            } else if line.starts_with("ID=") && !line.starts_with("ID_LIKE") {
                id = line.trim_start_matches("ID=").trim_matches('"').to_lowercase();
            } else if line.starts_with("ID_LIKE=") {
                id_like = line.trim_start_matches("ID_LIKE=").trim_matches('"').to_lowercase();
            }
        }
        info.os_id = id.clone();

        let family = match id.as_str() {
            "bazzite"|"silverblue"|"kinoite"|"aurora"|"bluefin"|"ucore" => "fedora-atomic",
            "steamos"|"holo" => "steamos",
            "cachyos"|"arch"|"endeavouros"|"garuda"|"manjaro"|"artix" => "arch",
            "ubuntu"|"debian"|"pop"|"linuxmint"|"elementary"|"neon" => "debian",
            "fedora"|"nobara" => {
                if std::path::Path::new("/run/ostree-booted").exists() { "fedora-atomic" } else { "fedora" }
            },
            _ => {
                if id_like.contains("arch") {
                    if std::path::Path::new("/etc/steamos-release").exists() { "steamos" } else { "arch" }
                } else if id_like.contains("fedora") || id_like.contains("rhel") {
                    if std::path::Path::new("/run/ostree-booted").exists() { "fedora-atomic" } else { "fedora" }
                } else if id_like.contains("debian") || id_like.contains("ubuntu") {
                    "debian"
                } else {
                    "unknown"
                }
            }
        };
        info.os_family = family.to_string();
        info.pkg_manager = match family {
            "fedora-atomic" => "rpm-ostree",
            "fedora"        => "dnf",
            "arch"          => "pacman",
            "steamos"       => "flatpak-only",
            "debian"        => "apt",
            _               => "unknown",
        }.to_string();
    }

    if let Ok(k) = std::fs::read_to_string("/proc/sys/kernel/osrelease") {
        info.kernel = k.trim().to_string();
    }

    info.desktop      = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    info.session_type = std::env::var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();

    if let Ok(content) = std::fs::read_to_string("/proc/cpuinfo") {
        for line in content.lines() {
            if line.starts_with("model name") && info.cpu_model.is_empty() {
                info.cpu_model = line.split_once(':').map(|x| x.1).unwrap_or("").trim().to_string();
            }
        }
        info.cpu_cores = format!("{} threads", content.lines().filter(|l| l.starts_with("processor")).count());
    }

    if let Ok(content) = std::fs::read_to_string("/proc/meminfo") {
        for line in content.lines() {
            if line.starts_with("MemTotal:") {
                if let Some(kb_str) = line.split_whitespace().nth(1) {
                    if let Ok(kb) = kb_str.parse::<u64>() {
                        info.ram_total_gb = format!("{:.1} GB", (kb as f64) / 1_048_576.0);
                    }
                }
                break;
            }
        }
    }

    let lspci = run_cmd("lspci", &[]);
    if lspci.success {
        for line in lspci.stdout.lines() {
            let lower = line.to_lowercase();
            if lower.contains("vga") || lower.contains("3d") || lower.contains("display") {
                let desc = line.split_once(':').map(|x| x.1).unwrap_or(line)
                    .split_once(':').map(|x| x.1).unwrap_or(line).trim().to_string();
                info.gpu_model = desc;
                info.gpu_vendor = if lower.contains("amd") || lower.contains("radeon") { "amd" }
                    else if lower.contains("nvidia") || lower.contains("geforce") { "nvidia" }
                    else if lower.contains("intel") { "intel" }
                    else { "unknown" }.to_string();
                break;
            }
        }
    }

    let df = run_cmd("df", &["-h", "--output=target,size,used,avail,pcent"]);
    if df.success {
        info.disk_info = df.stdout.lines().skip(1).filter(|l| {
            let t = l.split_whitespace().next().unwrap_or("");
            t == "/" || t.starts_with("/home") || t.starts_with("/mnt")
        }).map(|l| l.to_string()).collect();
    }

    info
}
