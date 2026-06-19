// src-tauri/src/cloudflare.rs — Cloudflare Tunnel setup for Jellyfin remote access
use crate::types::{CommandResult, run_cmd, dirs_home};

fn cf_bin(home: &str) -> String {
    let local = format!("{}/.local/bin/cloudflared", home);
    if std::path::Path::new(&local).exists() { local } else { "cloudflared".to_string() }
}

#[tauri::command]
pub fn cloudflared_check() -> CommandResult {
    let home = dirs_home().unwrap_or_else(|| "/tmp".to_string());
    run_cmd(&cf_bin(&home), &["--version"])
}

#[tauri::command]
pub fn cloudflared_install() -> CommandResult {
    let home = dirs_home().unwrap_or_else(|| "/tmp".to_string());
    let bin_dir = format!("{}/.local/bin", home);
    let out     = format!("{}/cloudflared", bin_dir);

    std::fs::create_dir_all(&bin_dir).ok();

    let arch = {
        let r = run_cmd("uname", &["-m"]);
        if r.success && (r.stdout.contains("aarch64") || r.stdout.contains("arm64")) {
            "arm64"
        } else {
            "amd64"
        }
    };

    let url = format!(
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-{}",
        arch
    );

    let r = run_cmd("curl", &["-L", "--fail", "--output", &out, &url]);
    if !r.success { return r; }

    let r2 = run_cmd("chmod", &["+x", &out]);
    if !r2.success { return r2; }

    run_cmd(&out, &["--version"])
}

#[tauri::command]
pub fn cloudflared_is_logged_in() -> CommandResult {
    let home = dirs_home().unwrap_or_else(|| "/tmp".to_string());
    let cert = format!("{}/.cloudflared/cert.pem", home);
    if std::path::Path::new(&cert).exists() {
        CommandResult::ok("logged-in".to_string())
    } else {
        CommandResult::err("not-logged-in".to_string())
    }
}

// Opens the system browser for Cloudflare OAuth — blocks until auth completes.
#[tauri::command]
pub fn cloudflared_login() -> CommandResult {
    let home = dirs_home().unwrap_or_else(|| "/tmp".to_string());
    run_cmd(&cf_bin(&home), &["tunnel", "login"])
}

#[tauri::command]
pub fn cloudflared_create_tunnel(tunnel_name: String) -> CommandResult {
    let home = dirs_home().unwrap_or_else(|| "/tmp".to_string());
    run_cmd(&cf_bin(&home), &["tunnel", "create", &tunnel_name])
}

// Writes ~/.cloudflared/config.yml pointing the tunnel at Jellyfin on port 8096.
#[tauri::command]
pub fn cloudflared_write_config(tunnel_name: String, hostname: String) -> CommandResult {
    let home       = dirs_home().unwrap_or_else(|| "/tmp".to_string());
    let config_dir = format!("{}/.cloudflared", home);
    let config_path= format!("{}/config.yml", config_dir);

    std::fs::create_dir_all(&config_dir).ok();

    let config = format!(
"tunnel: {tunnel_name}

ingress:
  - hostname: {hostname}
    service: http://localhost:8096
  - service: http_status:404
"
    );

    match std::fs::write(&config_path, &config) {
        Ok(_)  => CommandResult::ok(format!("Config written to {}", config_path)),
        Err(e) => CommandResult::err(format!("Failed to write config: {}", e)),
    }
}

// Creates a Cloudflare DNS CNAME pointing to the tunnel. Requires the domain
// to already be on Cloudflare. Failures are treated as warnings by the UI.
#[tauri::command]
pub fn cloudflared_route_dns(tunnel_name: String, hostname: String) -> CommandResult {
    let home = dirs_home().unwrap_or_else(|| "/tmp".to_string());
    run_cmd(&cf_bin(&home), &["tunnel", "route", "dns", &tunnel_name, &hostname])
}

// Writes a systemd user service and enables + starts it.
#[tauri::command]
pub fn cloudflared_service_install() -> CommandResult {
    let home        = dirs_home().unwrap_or_else(|| "/tmp".to_string());
    let bin_path    = cf_bin(&home);
    let config_path = format!("{}/.cloudflared/config.yml", home);
    let service_dir = format!("{}/.config/systemd/user", home);
    let service_path= format!("{}/cloudflared-jellyfin.service", service_dir);

    std::fs::create_dir_all(&service_dir).ok();

    let unit = format!(
r#"[Unit]
Description=Cloudflare Tunnel — Jellyfin
After=network-online.target
Wants=network-online.target

[Service]
ExecStart={bin_path} tunnel --config {config_path} run
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
"#
    );

    if let Err(e) = std::fs::write(&service_path, &unit) {
        return CommandResult::err(format!("Failed to write service unit: {}", e));
    }

    let r = run_cmd("systemctl", &["--user", "daemon-reload"]);
    if !r.success { return r; }

    let r2 = run_cmd("systemctl", &["--user", "enable", "--now", "cloudflared-jellyfin"]);
    if !r2.success { return r2; }

    CommandResult::ok(format!(
        "Cloudflare tunnel service installed and started.\nUnit: {}",
        service_path
    ))
}

#[tauri::command]
pub fn cloudflared_service_status() -> CommandResult {
    run_cmd("systemctl", &["--user", "is-active", "cloudflared-jellyfin"])
}

#[tauri::command]
pub fn cloudflared_service_start() -> CommandResult {
    run_cmd("systemctl", &["--user", "start", "cloudflared-jellyfin"])
}

#[tauri::command]
pub fn cloudflared_service_stop() -> CommandResult {
    run_cmd("systemctl", &["--user", "stop", "cloudflared-jellyfin"])
}
