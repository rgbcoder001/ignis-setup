// src-tauri/src/installs.rs — app installation commands
use crate::types::{CommandResult, run_cmd, host_command};

#[tauri::command]
pub fn install_flatpak_app(app_id: String) -> CommandResult {
    run_cmd("flatpak", &["install", "--user", "--noninteractive", "flathub", &app_id])
}

#[tauri::command]
pub fn check_flatpak_installed(app_id: String) -> CommandResult {
    run_cmd("flatpak", &["info", "--user", &app_id])
}

#[tauri::command]
pub fn run_ujust(recipe: String) -> CommandResult {
    if !host_command("which").arg("ujust").output().map(|o| o.status.success()).unwrap_or(false) {
        return CommandResult::err("ujust is not available on this system. It is a Bazzite/uBlue-specific tool.".into());
    }
    run_cmd("ujust", &[&recipe])
}

#[tauri::command]
pub fn install_rpm_ostree_pkg(pkg: String) -> CommandResult {
    run_cmd("rpm-ostree", &["install", "--idempotent", &pkg])
}

#[tauri::command]
pub fn run_bash_script(script_path: String) -> CommandResult {
    run_cmd("bash", &[&script_path])
}

#[tauri::command]
pub fn run_bash_script_with_args(script_path: String, args: Vec<String>) -> CommandResult {
    let str_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let mut all_args = vec![script_path.as_str()];
    all_args.extend(str_args);
    run_cmd("bash", &all_args)
}

#[tauri::command]
pub fn check_command_exists(cmd: String) -> bool {
    host_command("which").arg(&cmd).output().map(|o| o.status.success()).unwrap_or(false)
}
