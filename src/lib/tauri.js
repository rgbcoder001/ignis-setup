import { invoke } from "@tauri-apps/api/core";

// ── System info ───────────────────────────────────────────────────────────────
export const getSystemInfo       = ()                       => invoke("get_system_info");

// ── App installs ──────────────────────────────────────────────────────────────
export const installFlatpak      = (appId)                  => invoke("install_flatpak_app",         { appId });
export const checkFlatpak        = (appId)                  => invoke("check_flatpak_installed",     { appId });
export const runUjust            = (recipe)                 => invoke("run_ujust",                   { recipe });
export const runScript           = (scriptPath)             => invoke("run_bash_script",             { scriptPath });
export const runScriptArgs       = (scriptPath, args)       => invoke("run_bash_script_with_args",   { scriptPath, args });
export const checkCmdExists      = (cmd)                    => invoke("check_command_exists",        { cmd });

// Bazzite (Fedora Atomic) package install — layers via rpm-ostree
export const installRpmOstree    = (pkg)                    => invoke("install_rpm_ostree_pkg",      { pkg });

// ── Network ───────────────────────────────────────────────────────────────────
export const listConnections     = ()                       => invoke("list_connections");
export const setStaticIp         = (connection, ipCidr, gateway, dns) =>
  invoke("set_static_ip", { connection, ipCidr, gateway, dns });
export const setDhcp             = (connection)             => invoke("set_dhcp",            { connection });
export const mountNas            = (server, share, mountPt, username, password, protocol) =>
  invoke("mount_nas_share", { server, share, mountPt, username, password, protocol });
export const addFstabEntry       = (server, share, mountPt, username, protocol) =>
  invoke("add_fstab_entry", { server, share, mountPt, username, protocol });
export const testNas             = (server)                 => invoke("test_nas_connection", { server });

// ── Jellyfin ──────────────────────────────────────────────────────────────────
export const installJellyfin          = (mediaPath)                  => invoke("install_jellyfin",           { mediaPath });
export const jellyfinStatus           = ()                           => invoke("jellyfin_status");
export const jellyfinStart            = ()                           => invoke("jellyfin_start");
export const jellyfinStop             = ()                           => invoke("jellyfin_stop");
export const jellyfinRestart          = ()                           => invoke("jellyfin_restart");

// ── Cloudflare Tunnel ─────────────────────────────────────────────────────────
export const cloudflaredCheck         = ()                           => invoke("cloudflared_check");
export const cloudflaredInstall       = ()                           => invoke("cloudflared_install");
export const cloudflaredIsLoggedIn    = ()                           => invoke("cloudflared_is_logged_in");
export const cloudflaredLogin         = ()                           => invoke("cloudflared_login");
export const cloudflaredCreateTunnel  = (tunnelName)                 => invoke("cloudflared_create_tunnel",  { tunnelName });
export const cloudflaredWriteConfig   = (tunnelName, hostname)       => invoke("cloudflared_write_config",   { tunnelName, hostname });
export const cloudflaredRouteDns      = (tunnelName, hostname)       => invoke("cloudflared_route_dns",      { tunnelName, hostname });
export const cloudflaredServiceInstall= ()                           => invoke("cloudflared_service_install");
export const cloudflaredServiceStatus = ()                           => invoke("cloudflared_service_status");
export const cloudflaredServiceStart  = ()                           => invoke("cloudflared_service_start");
export const cloudflaredServiceStop   = ()                           => invoke("cloudflared_service_stop");

// ── GE-Proton ─────────────────────────────────────────────────────────────────
export const geProtonStatus      = ()                       => invoke("ge_proton_status");
export const installGeProton     = (scriptDir)              => invoke("install_ge_proton",   { scriptDir });
export const setGeProtonDefault  = (geVersion)              => invoke("set_ge_proton_default", { geVersion });

// ── Install log ───────────────────────────────────────────────────────────────
export const readInstallLog      = ()                       => invoke("read_install_log");
export const writeInstallLog     = (content)                => invoke("write_install_log", { content });

// ── Steam ─────────────────────────────────────────────────────────────────────
export const isSteamRunning      = ()                       => invoke("is_steam_running");

