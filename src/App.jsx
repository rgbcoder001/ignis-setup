// src/App.jsx — Main application orchestrator
import React, { useState, useEffect, useCallback } from "react";
import { APPS, CATEGORIES, getInstallMethod, getOsSupport } from "./lib/apps.js";
import { checkFlatpak, checkCmdExists,
         installFlatpak, runUjust, runScript, runScriptArgs,
         installRpmOstree,
         installJellyfin, jellyfinStatus, jellyfinStart, jellyfinStop, jellyfinRestart,
         cloudflaredCheck, cloudflaredInstall, cloudflaredIsLoggedIn, cloudflaredLogin,
         cloudflaredCreateTunnel, cloudflaredWriteConfig, cloudflaredRouteDns,
         cloudflaredServiceInstall, cloudflaredServiceStatus,
         cloudflaredServiceStart, cloudflaredServiceStop,
         listConnections, setStaticIp, setDhcp,
         testNas, mountNas, addFstabEntry,
         geProtonStatus, installGeProton, setGeProtonDefault,
         readInstallLog, writeInstallLog,
         getSystemInfo } from "./lib/tauri.js";
import { fetchVersionsStaggered, logInstall, isFirstRun,
         fetchLatestGithubVersionCached } from "./hooks/useInstallLog.js";

// Shared UI
import { s, Btn, Badge, NavBtn, Terminal, Spinner,
         GpuCompatBadge, OsSupportBadge, Modal, ModalHeader } from "./components/ui.jsx";
// Feature panels
import GeProtonPanel from "./components/GeProtonPanel.jsx";
import { OBSPanel, DiscordPanel, HandbrakePanel, EmuDeckPanel } from "./components/AppPanels.jsx";
import WelcomeScreen from "./components/WelcomeScreen.jsx";

// System info context — shared across all pages
import SysInfoContext from "./context/SysInfoContext.js";

// Network validation
import { ipCidrError, ipError, dnsError } from "./lib/network.js";

// ── Apps page ─────────────────────────────────────────────────────────────────
function AppsPage({ category, gpuVendor }) {
  const sysInfo  = React.useContext(SysInfoContext);
  const osFamily = sysInfo?.os_family || null;

  const [statuses,  setStatuses]  = useState(() =>
    Object.fromEntries(APPS.map(a => [a.id, { state:"checking", latest:null }]))
  );
  const [selected,  setSelected]  = useState(new Set());
  const [termLines, setTermLines] = useState([]);
  const [installing,setInstalling]= useState(null);
  const [installLog,setInstallLog]= useState({});
  const [gePanel,   setGePanel]   = useState(false);
  const [obsPanel,  setObsPanel]  = useState(false);
  const [discPanel, setDiscPanel] = useState(false);
  const [hbPanel,   setHbPanel]   = useState(false);
  const [emuPanel,  setEmuPanel]  = useState(false);

  const log = (text, type="muted") => setTermLines(p => [...p, {text,type}]);

  // Load install log on mount
  useEffect(() => {
    readInstallLog().then(r => {
      if (r.success) try { setInstallLog(JSON.parse(r.stdout)); } catch {}
    }).catch(() => {});
  }, []);

  // Staggered version checks — avoids GitHub rate limit
  const checkStatuses = useCallback(async () => {
    setStatuses(p => Object.fromEntries(APPS.map(a => [a.id, { ...p[a.id], state:"checking" }])));
    const versions = await fetchVersionsStaggered(APPS);

    await Promise.all(APPS.map(async (app) => {
      let state = "not-installed";
      const m = getInstallMethod(app, osFamily) || getInstallMethod(app, "any");

      // Pre-installed: check if this OS family has a "preinstalled" method
      const isPreinstalledForOs = m?.method === "preinstalled" ||
        m?.method === "preinstalled-or-ujust";

      if (isPreinstalledForOs) {
        // Verify it's actually present via checkCmd
        if (app.checkCmd) {
          try { state = (await checkCmdExists(app.checkCmd)) ? "pre" : "not-installed"; } catch { state = "pre"; }
        } else {
          state = "pre";
        }
      } else {
        // Prefer checkFlatpakId over checkCmd for Flatpak-installed apps
        const flatpakId = app.checkFlatpakId || m?.flatpakId;
        const cmd       = app.checkCmd;

        if (flatpakId) {
          try { state = (await checkFlatpak(flatpakId)).success ? "installed" : "not-installed"; } catch {}
          // If not found via Flatpak, try cmd as secondary check
          if (state === "not-installed" && cmd) {
            try { state = (await checkCmdExists(cmd)) ? "installed" : "not-installed"; } catch {}
          }
        } else if (cmd) {
          try { state = (await checkCmdExists(cmd)) ? "installed" : "not-installed"; } catch {}
        }
      }

      const latest = versions[app.id];
      setStatuses(p => ({ ...p, [app.id]: { state, latest } }));
    }));
  }, [osFamily]);

  useEffect(() => { checkStatuses(); }, []);

  const toggle = id => setSelected(p => {
    const next = new Set(p); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  const installSelected = async () => {
    const apps = APPS.filter(a => selected.has(a.id));
    setTermLines([]);
    log("# Starting installation", "info");
    for (const app of apps) {
      setInstalling(app.id);
      log(`\n→ ${app.name}...`, "info");
      const osCheck = getOsSupport(app, osFamily);
      if (osCheck?.level === "unavailable") {
        log(`  [SKIP] Not available on ${osFamily}: ${osCheck.note}`, "warn");
        continue;
      }
      const method = getInstallMethod(app, osFamily) || getInstallMethod(app, "any");
      if (!method) { log(`  [SKIP] No install method defined`, "warn"); continue; }

      let r, success = false;
      try {
        if      (method.scriptFile)                          r = await runScript(`./scripts/${method.scriptFile}`);
        else if (method.method === "flatpak" && method.flatpakId)    r = await installFlatpak(method.flatpakId);
        else if (method.method === "ujust"   && method.ujustRecipe)  r = await runUjust(method.ujustRecipe);
        else if (method.method === "rpm-ostree" && method.pkg)       r = await installRpmOstree(method.pkg);
        else if (method.method.startsWith("preinstalled")) {
          log(`  ✓ ${app.name} is pre-installed`, "ok"); continue;
        }
        else { log(`  [SKIP] Unhandled method: ${method.method}`, "warn"); continue; }

        success = r?.success || false;
        if (success) log(`  ✓ ${app.name} installed`, "ok");
        else         log(`  ✗ ${app.name} failed: ${r?.stderr || r?.stdout || "unknown"}`, "err");
      } catch(e) {
        log(`  ✗ ${app.name}: ${e}`, "err");
      }

      // Write to install log
      const updatedLog = await logInstall(app.id, app.name, method.method, success);
      setInstallLog(updatedLog);
    }
    setInstalling(null);
    log("\n# Done — refreshing status…", "info");
    await checkStatuses();
  };

  const filtered    = category === "All" ? APPS : APPS.filter(a => a.category === category);
  const updateCount = APPS.filter(a => statuses[a.id]?.state === "update").length;

  return (
    <div>
      {gePanel   && <GeProtonPanel  onClose={() => setGePanel(false)}/>}
      {obsPanel  && <OBSPanel       onClose={() => setObsPanel(false)}  gpuVendor={gpuVendor}/>}
      {discPanel && <DiscordPanel   onClose={() => setDiscPanel(false)}/>}
      {hbPanel   && <HandbrakePanel onClose={() => setHbPanel(false)}/>}
      {emuPanel  && <EmuDeckPanel   onClose={() => setEmuPanel(false)}/>}

      <div style={{...s.row, marginBottom:16, justifyContent:"space-between"}}>
        <div>
          <h2 style={{fontSize:20,fontWeight:700}}>{category === "All" ? "All Apps" : category}</h2>
          <p style={{color:"var(--muted)",fontSize:13,marginTop:3}}>
            Select apps to install. Versions checked live from GitHub.
          </p>
        </div>
        <div style={s.row}>
          {updateCount > 0 && <Badge type="update">⬆ {updateCount} update{updateCount>1?"s":""}</Badge>}
          <Btn variant="ghost" small onClick={() => setSelected(new Set(APPS.filter(a=>!a.preinstalled).map(a=>a.id)))}>Select all</Btn>
          <Btn variant="ghost" small onClick={() => setSelected(new Set())}>Clear</Btn>
          <Btn onClick={installSelected} disabled={selected.size===0||!!installing}>
            {installing ? <><Spinner/> Installing…</> : `⚙ Install (${selected.size})`}
          </Btn>
          <Btn variant="ghost" small onClick={checkStatuses}>⟳</Btn>
        </div>
      </div>

      <div style={s.grid}>
        {filtered.map(app => {
          const st = statuses[app.id] || { state:"checking" };
          const isInstalling = installing === app.id;
          const logEntry = installLog[app.id];
          const m = getInstallMethod(app, osFamily) || getInstallMethod(app, "any");
          const methodLabel = m?.flatpakId || m?.ujustRecipe || m?.pkg || m?.aur || m?.scriptFile || m?.method || "—";

          return (
            <div key={app.id} style={{
              ...s.card,
              borderColor: selected.has(app.id) ? "var(--accent)" : "var(--border)",
              transition:"border-color .15s",
              opacity: getOsSupport(app, osFamily)?.level === "unavailable" ? 0.45 : 1,
            }}>
              <div style={{...s.row, marginBottom:10}}>
                {!app.preinstalled &&
                  <input type="checkbox" checked={selected.has(app.id)} onChange={() => toggle(app.id)}
                    style={{width:15,height:15,accentColor:"var(--accent)",cursor:"pointer",flexShrink:0}}/>}
                <div style={{width:38,height:38,borderRadius:8,background:app.iconBg,
                             display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>
                  {app.icon}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:14}}>{app.name}</div>
                  <div style={{fontSize:11,color:"var(--muted)"}}>{app.category}</div>
                </div>
                <span style={{fontSize:10,padding:"2px 6px",borderRadius:3,
                              background:"var(--surface2)",color:"var(--muted)",
                              border:"1px solid var(--border)",fontFamily:"var(--mono)"}}>
                  {m?.method || "—"}
                </span>
              </div>

              <p style={{fontSize:12,color:"var(--muted)",lineHeight:1.55,marginBottom:10}}>{app.desc}</p>

              <div style={{...s.row,flexWrap:"wrap",gap:6,marginBottom:8}}>
                {isInstalling && <Badge type="checking"><Spinner/> Installing…</Badge>}
                {!isInstalling && st.state === "checking"      && <Badge type="checking"><Spinner/> Checking</Badge>}
                {!isInstalling && st.state === "pre"           && <Badge type="pre">✓ Pre-installed</Badge>}
                {!isInstalling && st.state === "installed"     && <Badge type="installed">✓ Installed</Badge>}
                {!isInstalling && st.state === "not-installed" && <Badge type="missing">Not installed</Badge>}
                {st.latest && <Badge type="latest">latest: {st.latest}</Badge>}
                <GpuCompatBadge app={app} gpuVendor={gpuVendor}/>
                <OsSupportBadge app={app} osFamily={osFamily}/>
              </div>

              {logEntry && (
                <div style={{fontSize:10,color:"var(--muted)",marginBottom:6,fontFamily:"var(--mono)"}}>
                  Last installed: {new Date(logEntry.installedAt).toLocaleDateString()}
                  {logEntry.success ? " ✓" : " ✗ (failed)"}
                </div>
              )}

              <div style={s.row}>
                <div style={{...s.card,...s.mono,flex:1,padding:"5px 9px",fontSize:11,
                             color:"var(--muted)",overflow:"hidden",whiteSpace:"nowrap",
                             textOverflow:"ellipsis",cursor:"text"}}>
                  {methodLabel}
                </div>
                {app.hasPanel          && <Btn small variant="ghost" onClick={() => setGePanel(true)}>Manage →</Btn>}
                {app.hasOBSPanel       && <Btn small variant="ghost" onClick={() => setObsPanel(true)}>Configure →</Btn>}
                {app.hasDiscordPanel   && <Btn small variant="ghost" onClick={() => setDiscPanel(true)}>Configure →</Btn>}
                {app.hasHandbrakePanel && <Btn small variant="ghost" onClick={() => setHbPanel(true)}>Configure →</Btn>}
                {app.hasEmuDeckPanel   && <Btn small variant="ghost" onClick={() => setEmuPanel(true)}>Configure →</Btn>}
              </div>
            </div>
          );
        })}
      </div>
      <Terminal lines={termLines}/>
    </div>
  );
}
// ── Network page ──────────────────────────────────────────────────────────────

function NetworkPage() {
  const [tab, setTab] = useState("static");
  const [connections, setConnections] = useState([]);
  const [selConn, setSelConn] = useState("");
  const [ip, setIp] = useState("192.168.1.");
  const [gw, setGw] = useState("192.168.1.1");
  const [dns, setDns] = useState("1.1.1.1,8.8.8.8");
  const [termLines, setTermLines] = useState([]);
  const [busy, setBusy] = useState(false);

  // NAS state
  const [nasServer, setNasServer] = useState("");
  const [nasShare,  setNasShare]  = useState("Media");
  const [nasMountPt, setNasMountPt] = useState("/mnt/nas/media");
  const [nasUser,   setNasUser]   = useState("");
  const [nasPass,   setNasPass]   = useState("");
  const [nasProto,  setNasProto]  = useState("smb");
  const [nasPersist,setNasPersist]= useState(true);
  const [nasPing,   setNasPing]   = useState(null);

  const log = (text, type="muted") => setTermLines(p => [...p, {text,type}]);

  useEffect(() => {
    listConnections().then(r => {
      if (r.success) {
        const lines = r.stdout.split("\n").filter(Boolean).map(l => l.split(":")[0]);
        setConnections(lines);
        if (lines.length) setSelConn(lines[0]);
      }
    }).catch(() => {});
  }, []);

  const [ipErr,  setIpErr]  = useState("");
  const [gwErr,  setGwErr]  = useState("");
  const [dnsErr, setDnsErr] = useState("");

  const applyStaticIp = async () => {
    // Validate before touching nmcli — use error-returning helpers (null = valid)
    const ipErr_ = ipCidrError(ip);
    const gwErr_ = ipError(gw);
    const dnsErr_= dnsError(dns);
    setIpErr(ipErr_   || "");
    setGwErr(gwErr_   || "");
    setDnsErr(dnsErr_ || "");
    if (ipErr_ || gwErr_ || dnsErr_ || !selConn) return;
    let ok = true; // retained for flow compatibility below
    if (!ok || !selConn) return;
    setBusy(true); setTermLines([]);
    log(`Setting static IP ${ip} on '${selConn}'...`, "info");
    try {
      const r = await setStaticIp(selConn, ip, gw, dns);
      if (r.success) { log("✓ Static IP applied. Connection brought up.", "ok"); log(r.stdout, "muted"); }
      else           { log("✗ Failed: " + r.stderr, "err"); }
    } catch(e) { log("✗ " + e, "err"); }
    setBusy(false);
  };

  const revertDhcp = async () => {
    setBusy(true); setTermLines([]);
    log(`Reverting '${selConn}' to DHCP...`, "info");
    try {
      const r = await setDhcp(selConn);
      log(r.success ? "✓ Reverted to DHCP." : "✗ " + r.stderr, r.success ? "ok" : "err");
    } catch(e) { log("✗ " + e, "err"); }
    setBusy(false);
  };

  const pingNas = async () => {
    if (!nasServer) return;
    setNasPing(null);
    const r = await testNas(nasServer).catch(() => ({ success:false }));
    setNasPing(r.success);
  };

  const mountNasShare = async () => {
    setBusy(true); setTermLines([]);
    log(`Mounting //${nasServer}/${nasShare} → ${nasMountPt}`, "info");
    try {
      const r = await mountNas(nasServer, nasShare, nasMountPt, nasUser, nasPass, nasProto);
      if (r.success) {
        log("✓ Mounted successfully.", "ok");
        if (nasPersist) {
          const r2 = await addFstabEntry(nasServer, nasShare, nasMountPt, nasUser, nasProto);
          log(r2.success ? "✓ Entry added to /etc/fstab (persistent across reboots)." : "⚠ fstab write failed: " + r2.stderr,
              r2.success ? "ok" : "warn");
        }
      } else { log("✗ Mount failed: " + r.stderr, "err"); }
    } catch(e) { log("✗ " + e, "err"); }
    setBusy(false);
  };

  const Tab = ({id, label}) => (
    <button onClick={() => setTab(id)}
      style={{ background: tab===id ? "rgba(224,92,42,.15)" : "transparent",
               color: tab===id ? "var(--accent2)" : "var(--muted)",
               border:"none", borderBottom: tab===id ? "2px solid var(--accent)" : "2px solid transparent",
               padding:"8px 16px", cursor:"pointer", fontSize:13, fontWeight: tab===id ? 600 : 400 }}>
      {label}
    </button>
  );

  return (
    <div>
      <div style={{marginBottom:16}}>
        <h2 style={{fontSize:20,fontWeight:700}}>Network</h2>
        <p style={{color:"var(--muted)",fontSize:13,marginTop:3}}>Static IP, NAS mount, Jellyfin server, and Windows migration.</p>
      </div>

      <div style={{...s.row, borderBottom:"1px solid var(--border)", marginBottom:20}}>
        <Tab id="static"     label="📡 Static IP"/>
        <Tab id="nas"        label="🗄️ NAS Mount"/>
        <Tab id="jf"         label="📺 Jellyfin Server"/>
        <Tab id="cloudflare" label="☁️ Cloudflare Tunnel"/>
        <Tab id="migrate"    label="🔄 Migrate from Windows"/>
      </div>

      {/* ── Static IP tab ─────────────────────────────────────────────── */}
      {tab === "static" && (
        <div style={{...s.card, maxWidth:560}}>
          <h3 style={{fontWeight:700,marginBottom:4}}>Set a Static IP Address</h3>
          <p style={{color:"var(--muted)",fontSize:12,marginBottom:16,lineHeight:1.6}}>
            Prevents your IP from changing after a reboot. Required if you want Jellyfin
            or other services to always be reachable at the same address.
          </p>

          <div style={{marginBottom:12}}>
            <div style={s.label}>Network connection</div>
            <select value={selConn} onChange={e=>setSelConn(e.target.value)} style={s.select}>
              {connections.map(c => <option key={c} value={c}>{c}</option>)}
              {!connections.length && <option>Loading…</option>}
            </select>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
            <div>
              <div style={s.label}>IP address (with /24 or /16)</div>
              <input style={{...s.input, borderColor: ipErr ? "var(--red)" : undefined}}
                value={ip} onChange={e=>{setIp(e.target.value);setIpErr("");}} placeholder="192.168.1.50/24"/>
              {ipErr && <div style={{fontSize:11,color:"var(--red)",marginTop:3}}>{ipErr}</div>}
            </div>
            <div>
              <div style={s.label}>Gateway (your router)</div>
              <input style={{...s.input, borderColor: gwErr ? "var(--red)" : undefined}}
                value={gw} onChange={e=>{setGw(e.target.value);setGwErr("");}} placeholder="192.168.1.1"/>
              {gwErr && <div style={{fontSize:11,color:"var(--red)",marginTop:3}}>{gwErr}</div>}
            </div>
          </div>
          <div style={{marginBottom:16}}>
            <div style={s.label}>DNS servers (comma-separated)</div>
            <input style={{...s.input, borderColor: dnsErr ? "var(--red)" : undefined}}
              value={dns} onChange={e=>{setDns(e.target.value);setDnsErr("");}} placeholder="1.1.1.1,8.8.8.8"/>
            {dnsErr && <div style={{fontSize:11,color:"var(--red)",marginTop:3}}>{dnsErr}</div>}
          </div>

          <div style={s.row}>
            <Btn onClick={applyStaticIp} disabled={busy}>
              {busy ? <><Spinner/> Applying…</> : "Apply static IP"}
            </Btn>
            <Btn variant="ghost" onClick={revertDhcp} disabled={busy}>Revert to DHCP</Btn>
          </div>
          <Terminal lines={termLines}/>
        </div>
      )}

      {/* ── NAS tab ────────────────────────────────────────────────────── */}
      {tab === "nas" && (
        <div style={{...s.card, maxWidth:580}}>
          <h3 style={{fontWeight:700,marginBottom:4}}>Mount a NAS Share</h3>
          <p style={{color:"var(--muted)",fontSize:12,marginBottom:16,lineHeight:1.6}}>
            Connects to a NAS (Synology, TrueNAS, etc.) over SMB or NFS. Optionally adds
            the mount to <span style={{fontFamily:"var(--mono)",color:"var(--blue)"}}>/etc/fstab</span> so
            it reconnects automatically after a reboot.
          </p>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
            <div>
              <div style={s.label}>NAS IP or hostname</div>
              <div style={s.row}>
                <input style={{...s.input,flex:1}} value={nasServer} onChange={e=>setNasServer(e.target.value)} placeholder="192.168.1.100"/>
                <Btn variant="ghost" small onClick={pingNas}>Ping</Btn>
              </div>
              {nasPing === true  && <div style={{fontSize:11,color:"var(--green)",marginTop:4}}>✓ Reachable</div>}
              {nasPing === false && <div style={{fontSize:11,color:"var(--red)",  marginTop:4}}>✗ Not reachable</div>}
            </div>
            <div>
              <div style={s.label}>Protocol</div>
              <select style={s.select} value={nasProto} onChange={e=>setNasProto(e.target.value)}>
                <option value="smb">SMB / CIFS (Windows shares, Synology)</option>
                <option value="nfs">NFS (Linux-to-Linux, TrueNAS)</option>
              </select>
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
            <div>
              <div style={s.label}>Share name</div>
              <input style={s.input} value={nasShare} onChange={e=>setNasShare(e.target.value)} placeholder="Media"/>
            </div>
            <div>
              <div style={s.label}>Local mount point</div>
              <input style={s.input} value={nasMountPt} onChange={e=>setNasMountPt(e.target.value)} placeholder="/mnt/nas/media"/>
            </div>
          </div>

          {nasProto === "smb" && (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
              <div>
                <div style={s.label}>Username (leave blank for guest)</div>
                <input style={s.input} value={nasUser} onChange={e=>setNasUser(e.target.value)} placeholder="billy"/>
              </div>
              <div>
                <div style={s.label}>Password</div>
                <input type="password" style={s.input} value={nasPass} onChange={e=>setNasPass(e.target.value)}/>
              </div>
            </div>
          )}

          <label style={{...s.row, cursor:"pointer", marginBottom:14}}>
            <input type="checkbox" checked={nasPersist} onChange={e=>setNasPersist(e.target.checked)}
              style={{accentColor:"var(--accent)"}}/>
            <span style={{fontSize:13}}>Add to <code style={{fontFamily:"var(--mono)",color:"var(--blue)"}}>/etc/fstab</code> (reconnect on reboot)</span>
          </label>

          <Btn onClick={mountNasShare} disabled={busy||!nasServer}>
            {busy ? <><Spinner/> Mounting…</> : "Mount share"}
          </Btn>
          <Terminal lines={termLines}/>
        </div>
      )}

      {/* ── Jellyfin tab ───────────────────────────────────────────────── */}
      {tab === "jf" && <JellyfinPanel/>}

      {/* ── Cloudflare Tunnel tab ──────────────────────────────────────── */}
      {tab === "cloudflare" && <CloudflarePanel/>}

      {/* ── Migration tab ──────────────────────────────────────────────── */}
      {tab === "migrate" && <JellyfinMigrationPanel/>}
    </div>
  );
}

// ── Jellyfin panel ────────────────────────────────────────────────────────────

function JellyfinPanel() {
  const [mediaPath, setMediaPath] = useState("/mnt/nas/media");
  const [status, setStatus]       = useState("unknown");
  const [termLines, setTermLines] = useState([]);
  const [busy, setBusy]           = useState(false);

  const log = (text, type="muted") => setTermLines(p => [...p, {text,type}]);

  const refreshStatus = async () => {
    try {
      const r = await jellyfinStatus();
      setStatus(r.success ? r.stdout.trim() : "inactive");
    } catch { setStatus("unknown"); }
  };

  useEffect(() => { refreshStatus(); const t = setInterval(refreshStatus, 5000); return () => clearInterval(t); }, []);

  const install = async () => {
    setBusy(true); setTermLines([]);
    log("Installing Jellyfin via Podman Quadlet (the standard container method)...", "info");
    log(`Media path: ${mediaPath}`, "muted");
    try {
      const r = await installJellyfin(mediaPath);
      if (r.success) { log("✓ " + r.stdout, "ok"); log("\nOpen: http://localhost:8096", "info"); }
      else           { log("✗ " + r.stderr, "err"); }
    } catch(e) { log("✗ " + e, "err"); }
    await refreshStatus();
    setBusy(false);
  };

  const statusColour = { active:"var(--green)", inactive:"var(--muted)", activating:"var(--yellow)", failed:"var(--red)", unknown:"var(--muted)" };
  const statusLabel  = { active:"● Running", inactive:"○ Stopped", activating:"◎ Starting…", failed:"✗ Failed", unknown:"— Unknown" };

  return (
    <div style={{...s.card, maxWidth:580}}>
      <h3 style={{fontWeight:700,marginBottom:4}}>Jellyfin Media Server</h3>
      <p style={{color:"var(--muted)",fontSize:12,marginBottom:16,lineHeight:1.6}}>
        Self-hosted media server that streams your movies and TV shows to any device on
        your network. Installed as a <strong>Podman Quadlet</strong> — the recommended
        Linux method for running containers as auto-starting systemd services.
        After install, finish setup at <a href="http://localhost:8096"
        style={{color:"var(--blue)"}}>http://localhost:8096</a>.
      </p>

      <div style={{...s.row, marginBottom:16}}>
        <div style={{fontSize:13, fontWeight:700, color: statusColour[status] || statusColour.unknown}}>
          {statusLabel[status] || statusLabel.unknown}
        </div>
        {status === "active" && <a href="http://localhost:8096" target="_blank" rel="noreferrer"
          style={{fontSize:12, color:"var(--blue)", marginLeft:8}}>Open dashboard ↗</a>}
      </div>

      <div style={{marginBottom:14}}>
        <div style={s.label}>Media folder path (your movies/TV location)</div>
        <input style={s.input} value={mediaPath} onChange={e=>setMediaPath(e.target.value)}
          placeholder="/mnt/nas/media"/>
        <div style={{fontSize:11,color:"var(--muted)",marginTop:4}}>
          This folder will be mounted read-only inside the container. Use your NAS mount point above,
          or a local folder.
        </div>
      </div>

      <div style={s.row}>
        <Btn onClick={install} disabled={busy||!mediaPath}>
          {busy ? <><Spinner/> Installing…</> : status==="active" ? "Reinstall" : "Install & start"}
        </Btn>
        {status === "active" && <>
          <Btn variant="ghost" onClick={() => { setTermLines([]); jellyfinRestart().then(r=>log(r.success?"✓ Restarted":"✗ "+r.stderr,r.success?"ok":"err")); }}>Restart</Btn>
          <Btn variant="danger" onClick={() => { setTermLines([]); jellyfinStop().then(r=>{ log(r.success?"✓ Stopped":"✗ "+r.stderr,r.success?"ok":"err"); refreshStatus(); }); }}>Stop</Btn>
        </>}
        {status !== "active" && status !== "unknown" &&
          <Btn variant="success" onClick={() => { setTermLines([]); jellyfinStart().then(r=>{ log(r.success?"✓ Started":"✗ "+r.stderr,r.success?"ok":"err"); refreshStatus(); }); }}>Start</Btn>}
        <Btn variant="ghost" onClick={refreshStatus} small>⟳</Btn>
      </div>
      <Terminal lines={termLines}/>
    </div>
  );
}

// ── Jellyfin migration panel ──────────────────────────────────────────────────

function JellyfinMigrationPanel() {
  // Migration mode: "clean" = import config only, rescan media
  //                 "full"  = rewrite library.db paths, preserve watch history
  const [mode, setMode]           = useState("clean");
  const [step, setStep]           = useState(0);      // which step of the wizard

  // Step 0 — choose mode
  // Step 1 — locate the Windows backup zip or folder
  // Step 2 — path mapping (Windows paths → Linux paths)
  // Step 3 — run migration
  // Step 4 — done

  const [backupPath, setBackupPath] = useState("");
  // Default path mappings are pre-filled based on detected OS
  const sysInfoForMigration = React.useContext(SysInfoContext);
  const defaultMaps = (() => {
    const base = "/mnt/nas/media";
    return [
      { win: "D:\\Movies", linux: `${base}/Movies` },
      { win: "D:\\TV",     linux: `${base}/TV`     },
      { win: "D:\\Music",  linux: `${base}/Music`  },
    ];
  })();
  const [pathMaps, setPathMaps] = useState(defaultMaps);
  const [termLines, setTermLines]   = useState([]);
  const [busy, setBusy]             = useState(false);
  const [done, setDone]             = useState(false);

  const log = (text, type="muted") => setTermLines(p => [...p, {text, type}]);

  const addMap = () => setPathMaps(p => [...p, { win:"", linux:"" }]);
  const removeMap = (i) => setPathMaps(p => p.filter((_,idx) => idx !== i));
  const updateMap = (i, field, val) =>
    setPathMaps(p => p.map((m,idx) => idx===i ? {...m,[field]:val} : m));

  const runMigration = async () => {
    if (!backupPath) { log("⚠ Please enter the path to your Windows backup folder or ZIP.", "warn"); return; }
    setBusy(true); setDone(false); setTermLines([]);

    log("═══════════════════════════════════════════════", "info");
    log(" Jellyfin Windows → Linux Migration", "info");
    log("═══════════════════════════════════════════════", "info");
    log(`Mode:   ${mode === "clean" ? "Clean (config + settings, rescan media)" : "Full (preserve watch history + path rewrite)"}`, "muted");
    log(`Source: ${backupPath}`, "muted");
    log("", "muted");

    const mapArgs = pathMaps
      .filter(m => m.win && m.linux)
      .flatMap(m => ["--map", `${m.win}::${m.linux}`]);

    try {
      const r = await runScriptArgs("./scripts/migrate-jellyfin.sh", [
        "--mode",   mode,
        "--source", backupPath,
        ...mapArgs,
      ]);
      const lines = (r.stdout || "").split("\n");
      lines.forEach(l => {
        if (!l.trim()) return;
        const type = l.includes("[OK]") || l.startsWith("✓") ? "ok"
          : l.includes("[WARN]") || l.startsWith("⚠") ? "warn"
          : l.includes("[ERROR]") || l.startsWith("✗") ? "err"
          : l.includes("[INFO]") || l.startsWith("→") ? "info"
          : "muted";
        log(l, type);
      });
      if (r.success) {
        setDone(true);
        setStep(4);
      } else {
        log("✗ Migration failed. See output above.", "err");
        log("Your existing Jellyfin data was not modified — a backup was made first.", "warn");
      }
    } catch(e) { log("✗ " + e, "err"); }
    setBusy(false);
  };

  // ── Step indicators ───────────────────────────────────────────────────────
  const steps = ["Choose mode", "Locate backup", "Map paths", "Run migration", "Done"];

  const StepDot = ({i, label}) => (
    <div style={{display:"flex",alignItems:"center",gap:6}}>
      <div style={{
        width:24, height:24, borderRadius:"50%", display:"flex",
        alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700,
        flexShrink:0,
        background: i < step ? "var(--green)" : i === step ? "var(--accent)" : "var(--surface2)",
        color:      i < step ? "#000"         : i === step ? "#fff"          : "var(--muted)",
        border: `1px solid ${i <= step ? "transparent" : "var(--border)"}`,
      }}>{i < step ? "✓" : i+1}</div>
      <span style={{fontSize:12, color: i === step ? "var(--text)" : "var(--muted)", fontWeight: i===step?600:400}}>
        {label}
      </span>
      {i < steps.length-1 && <div style={{flex:1, height:1, background:"var(--border)", marginLeft:4}}/>}
    </div>
  );

  return (
    <div style={{maxWidth:700}}>
      <h3 style={{fontWeight:700,fontSize:16,marginBottom:4}}>Migrate Jellyfin from Windows</h3>
      <p style={{color:"var(--muted)",fontSize:12,marginBottom:20,lineHeight:1.6}}>
        Move your existing Jellyfin server from a Windows machine to this Linux machine.
        Your media stays on the NAS — only the Jellyfin configuration and metadata moves.
      </p>

      {/* Step progress bar */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:4,marginBottom:24}}>
        {steps.map((label,i) => <StepDot key={i} i={i} label={label}/>)}
      </div>

      {/* ── Step 0: Choose mode ─────────────────────────────────────────── */}
      {step === 0 && (
        <div style={s.col}>
          <div style={{fontWeight:600,marginBottom:8}}>What do you want to migrate?</div>
          {[
            {
              value: "clean",
              title: "Quick migration — settings & config only",
              icon: "⚡",
              desc: "Copies your users, API keys, plugins, and server settings. Media gets rescanned from scratch. " +
                    "You lose watch history and play counts, but it's fast and reliable. " +
                    "Recommended if your library is on a NAS (rescan takes minutes, not hours).",
              warn: null,
            },
            {
              value: "full",
              title: "Full migration — preserve watch history",
              icon: "🗄",
              desc: "Copies everything above PLUS rewrites the Jellyfin database (library.db) to replace " +
                    "Windows paths (e.g. D:\\Movies) with Linux paths (e.g. /mnt/nas/media/Movies). " +
                    "Preserves watched status, play counts, and ratings.",
              warn: "Requires Python 3 and SQLite3 on this machine. A full backup is made before any changes. " +
                    "If path rewriting fails, the original data is restored automatically.",
            },
          ].map(opt => (
            <label key={opt.value} style={{
              ...s.card, cursor:"pointer", padding:"14px 16px",
              borderColor: mode===opt.value ? "var(--accent)" : "var(--border)",
              background: mode===opt.value ? "rgba(224,92,42,.06)" : "var(--surface)",
            }}>
              <div style={{...s.row, marginBottom:6}}>
                <input type="radio" name="mode" value={opt.value} checked={mode===opt.value}
                  onChange={()=>setMode(opt.value)} style={{accentColor:"var(--accent)"}}/>
                <span style={{fontSize:16}}>{opt.icon}</span>
                <span style={{fontWeight:700,fontSize:14}}>{opt.title}</span>
              </div>
              <p style={{fontSize:12,color:"var(--muted)",lineHeight:1.6,marginLeft:22}}>{opt.desc}</p>
              {opt.warn && (
                <div style={{fontSize:11,color:"var(--yellow)",marginLeft:22,marginTop:6,lineHeight:1.5}}>
                  ⚠ {opt.warn}
                </div>
              )}
            </label>
          ))}
          <div style={{...s.row,marginTop:8,justifyContent:"flex-end"}}>
            <Btn onClick={()=>setStep(1)}>Next →</Btn>
          </div>
        </div>
      )}

      {/* ── Step 1: Locate backup ───────────────────────────────────────── */}
      {step === 1 && (
        <div style={s.col}>
          <div style={{...s.card,marginBottom:0}}>
            <div style={{fontWeight:600,marginBottom:12}}>
              📋 First: export your Jellyfin data from Windows
            </div>
            <div style={{fontSize:12,color:"var(--muted)",lineHeight:1.8}}>
              <strong style={{color:"var(--text)"}}>On your Windows machine, before shutting down Jellyfin:</strong><br/>
              1. Open Jellyfin dashboard → Administration → <strong>Backups</strong><br/>
              2. Click <strong>"Create Backup"</strong> — this creates a ZIP in your data folder<br/>
              <em style={{color:"var(--muted)"}}>
                Default backup location: <code style={{fontFamily:"var(--mono)",color:"var(--blue)"}}>
                C:\ProgramData\Jellyfin\Server\data\backups\</code>
              </em><br/><br/>
              <strong style={{color:"var(--text)"}}>OR copy the entire folder manually:</strong><br/>
              Copy <code style={{fontFamily:"var(--mono)",color:"var(--blue)"}}>C:\ProgramData\Jellyfin\Server</code> to
              a USB drive or your NAS share.<br/><br/>
              <strong style={{color:"var(--text)"}}>Then transfer to this Linux machine</strong> via USB, NAS share, or network copy.
            </div>
          </div>

          <div style={{marginTop:4}}>
            <div style={s.label}>Path to the backup ZIP or folder on this machine</div>
            <input style={s.input} value={backupPath} onChange={e=>setBackupPath(e.target.value)}
              placeholder="/mnt/nas/backup/jellyfin-backup.zip  or  /home/user/jellyfin-windows-backup"/>
            <div style={{fontSize:11,color:"var(--muted)",marginTop:4}}>
              This can be a <code style={{fontFamily:"var(--mono)"}}>.zip</code> file (from Jellyfin's built-in backup)
              or a folder (from manually copying the Windows data directory).
            </div>
          </div>

          <div style={{...s.row,justifyContent:"space-between",marginTop:8}}>
            <Btn variant="ghost" onClick={()=>setStep(0)}>← Back</Btn>
            <Btn onClick={()=>setStep(2)} disabled={!backupPath}>Next →</Btn>
          </div>
        </div>
      )}

      {/* ── Step 2: Path mapping ────────────────────────────────────────── */}
      {step === 2 && (
        <div style={s.col}>
          <div style={{...s.card,marginBottom:0}}>
            <div style={{fontWeight:600,marginBottom:4}}>Map Windows paths → Linux paths</div>
            <p style={{fontSize:12,color:"var(--muted)",lineHeight:1.6,marginBottom:12}}>
              Your media files are at Windows paths like <code style={{fontFamily:"var(--mono)",color:"var(--yellow)"}}>D:\Movies</code> in Jellyfin's database.
              On Linux they're at a different location. Add one row per top-level folder.
              {mode === "clean" && " In Clean mode these are used to reconfigure Jellyfin's library paths after import."}
              {mode === "full"  && " In Full mode these are used to rewrite paths in library.db."}
            </p>

            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:6,marginBottom:8}}>
              <div style={{fontSize:11,fontWeight:700,color:"var(--muted)"}}>WINDOWS PATH</div>
              <div style={{fontSize:11,fontWeight:700,color:"var(--muted)"}}>LINUX PATH</div>
              <div/>
              {pathMaps.map((m,i) => (
                <React.Fragment key={i}>
                  <input style={{...s.input,fontFamily:"var(--mono)",fontSize:11}}
                    value={m.win} onChange={e=>updateMap(i,"win",e.target.value)}
                    placeholder="D:\Movies"/>
                  <input style={{...s.input,fontFamily:"var(--mono)",fontSize:11}}
                    value={m.linux} onChange={e=>updateMap(i,"linux",e.target.value)}
                    placeholder="/mnt/nas/media/Movies"/>
                  <Btn variant="danger" small onClick={()=>removeMap(i)} style={{alignSelf:"center"}}>✕</Btn>
                </React.Fragment>
              ))}
            </div>
            <Btn variant="ghost" small onClick={addMap}>+ Add path mapping</Btn>
          </div>

          <div style={{...s.card,background:"rgba(78,166,245,.05)",border:"1px solid rgba(78,166,245,.2)"}}>
            <div style={{fontSize:12,color:"var(--blue)",lineHeight:1.7}}>
              <strong>Tip:</strong> Use your NAS mount point from the NAS Mount tab.<br/>
              Example: if your NAS media share is mounted at <code style={{fontFamily:"var(--mono)"}}>/mnt/nas/media</code>,
              and on Windows your movies were at <code style={{fontFamily:"var(--mono)"}}>D:\Media\Movies</code>,
              map <code style={{fontFamily:"var(--mono)"}}>D:\Media\Movies</code> →
              <code style={{fontFamily:"var(--mono)"}}>/mnt/nas/media/Movies</code>.
            </div>
          </div>

          <div style={{...s.row,justifyContent:"space-between"}}>
            <Btn variant="ghost" onClick={()=>setStep(1)}>← Back</Btn>
            <Btn onClick={()=>setStep(3)}>Next →</Btn>
          </div>
        </div>
      )}

      {/* ── Step 3: Review & run ────────────────────────────────────────── */}
      {step === 3 && (
        <div style={s.col}>
          <div style={s.card}>
            <div style={{fontWeight:600,marginBottom:10}}>Review before running</div>
            <div style={{display:"grid",gridTemplateColumns:"140px 1fr",gap:"4px 12px",fontSize:12}}>
              {[
                ["Mode",       mode==="clean" ? "Quick — config only, rescan media" : "Full — preserve watch history"],
                ["Source",     backupPath],
                ["Path maps",  pathMaps.filter(m=>m.win&&m.linux).length + " mapping(s) configured"],
                ["Backup",     "A timestamped backup of your current Jellyfin data will be created before any changes"],
              ].map(([k,v]) => (
                <React.Fragment key={k}>
                  <span style={{color:"var(--muted)",fontWeight:600}}>{k}</span>
                  <span style={{color:"var(--text)",fontFamily:k==="Source"?"var(--mono)":"inherit",fontSize:k==="Source"?11:12}}>{v}</span>
                </React.Fragment>
              ))}
            </div>
          </div>

          <div style={{background:"rgba(255,95,95,.07)",border:"1px solid rgba(255,95,95,.25)",
            borderRadius:6,padding:"10px 14px",fontSize:12,color:"var(--red)",lineHeight:1.7}}>
            ⚠ <strong>Jellyfin must be stopped before running.</strong> The script stops it automatically,
            but make sure no one is streaming from it. The migration will restart Jellyfin when done.
          </div>

          <div style={{...s.row}}>
            <Btn variant="ghost" onClick={()=>setStep(2)} disabled={busy}>← Back</Btn>
            <Btn onClick={runMigration} disabled={busy}>
              {busy ? <><Spinner/> Migrating…</> : "▶ Run migration"}
            </Btn>
          </div>
          <Terminal lines={termLines}/>
        </div>
      )}

      {/* ── Step 4: Done ───────────────────────────────────────────────── */}
      {step === 4 && (
        <div style={s.col}>
          <div style={{...s.card,background:"rgba(61,220,132,.06)",border:"1px solid rgba(61,220,132,.3)"}}>
            <div style={{fontSize:22,marginBottom:8}}>✅</div>
            <div style={{fontWeight:700,fontSize:16,color:"var(--green)",marginBottom:8}}>Migration complete!</div>
            <p style={{fontSize:12,color:"var(--muted)",lineHeight:1.7}}>
              Your Jellyfin configuration has been imported and the server has been restarted.
              Open the dashboard below to confirm everything looks correct.
            </p>
            <div style={{...s.row,marginTop:12}}>
              <a href="http://localhost:8096" target="_blank" rel="noreferrer"
                style={{color:"var(--blue)",fontSize:13}}>Open Jellyfin Dashboard ↗</a>
            </div>
          </div>

          <div style={{...s.card}}>
            <div style={{fontWeight:600,marginBottom:8}}>What to check in Jellyfin</div>
            <ul style={{fontSize:12,color:"var(--muted)",lineHeight:2,paddingLeft:18}}>
              <li>Dashboard → Libraries — confirm all library paths are correct</li>
              {mode==="clean" && <li>Click <strong>"Scan All Libraries"</strong> to rebuild metadata</li>}
              {mode==="full"  && <li>Dashboard → Libraries — verify watched status is preserved on a few titles</li>}
              <li>Dashboard → Users — confirm all users are present and can log in</li>
              <li>Dashboard → Plugins — confirm plugins are listed (may need to reinstall some)</li>
              <li>Try playing a file to confirm the media path is correctly mounted</li>
            </ul>
          </div>

          <Terminal lines={termLines}/>

          <Btn variant="ghost" onClick={()=>{setStep(0);setDone(false);setTermLines([]);}}>Start over</Btn>
        </div>
      )}
    </div>
  );
}

// ── Cloudflare Tunnel panel ───────────────────────────────────────────────────

function CloudflarePanel() {
  // phase: "check" | "install" | "login" | "configure" | "running"
  const [phase,        setPhase]       = useState("check");
  const [installed,    setInstalled]   = useState(null);
  const [loggedIn,     setLoggedIn]    = useState(null);
  const [svcStatus,    setSvcStatus]   = useState("unknown");
  const [tunnelName,   setTunnelName]  = useState("jellyfin");
  const [hostname,     setHostname]    = useState("");
  const [termLines,    setTermLines]   = useState([]);
  const [busy,         setBusy]        = useState(false);

  const log = (text, type = "muted") => setTermLines(p => [...p, { text, type }]);

  const checkAll = async () => {
    const binOk  = await cloudflaredCheck().catch(() => ({ success: false }));
    const certOk = await cloudflaredIsLoggedIn().catch(() => ({ success: false }));
    const svcOk  = await cloudflaredServiceStatus().catch(() => ({ success: false }));
    const svc    = svcOk.success ? svcOk.stdout.trim() : "inactive";

    setInstalled(binOk.success);
    setLoggedIn(certOk.success);
    setSvcStatus(svc);

    if      (!binOk.success)  setPhase("install");
    else if (!certOk.success) setPhase("login");
    else if (svc !== "active") setPhase("configure");
    else                       setPhase("running");
  };

  useEffect(() => { checkAll(); }, []);

  const doInstall = async () => {
    setBusy(true); setTermLines([]);
    log("Downloading cloudflared binary from GitHub…", "info");
    try {
      const r = await cloudflaredInstall();
      if (r.success) { log("✓ " + r.stdout.trim(), "ok"); setInstalled(true); setPhase("login"); }
      else           { log("✗ " + (r.stderr || r.stdout), "err"); }
    } catch(e) { log("✗ " + e, "err"); }
    setBusy(false);
  };

  const doLogin = async () => {
    setBusy(true); setTermLines([]);
    log("Opening Cloudflare login in your system browser…", "info");
    log("Complete the OAuth flow in the browser, then return here.", "muted");
    try {
      const r = await cloudflaredLogin();
      if (r.success) { log("✓ Logged in — cert.pem saved.", "ok"); setLoggedIn(true); setPhase("configure"); }
      else           { log("✗ " + (r.stderr || r.stdout), "err"); }
    } catch(e) { log("✗ " + e, "err"); }
    setBusy(false);
  };

  const doSetup = async () => {
    if (!tunnelName || !hostname) return;
    setBusy(true); setTermLines([]);

    log(`Creating tunnel "${tunnelName}"…`, "info");
    const r1 = await cloudflaredCreateTunnel(tunnelName).catch(e => ({ success: false, stderr: String(e) }));
    // "already exists" is acceptable — continue
    if (!r1.success && !r1.stdout?.includes("already exists") && !r1.stderr?.includes("already exists")) {
      log("✗ " + r1.stderr, "err"); setBusy(false); return;
    }
    log("✓ Tunnel ready.", "ok");

    log("Writing ~/.cloudflared/config.yml…", "info");
    const r2 = await cloudflaredWriteConfig(tunnelName, hostname).catch(e => ({ success: false, stderr: String(e) }));
    if (!r2.success) { log("✗ " + r2.stderr, "err"); setBusy(false); return; }
    log("✓ " + r2.stdout, "ok");

    log("Creating Cloudflare DNS route…", "info");
    const r3 = await cloudflaredRouteDns(tunnelName, hostname).catch(e => ({ success: false, stderr: String(e) }));
    if (r3.success) {
      log("✓ DNS CNAME created.", "ok");
    } else {
      log("⚠ DNS routing failed — add the CNAME manually in your Cloudflare dashboard.", "warn");
      log("  CNAME: " + hostname + " → " + tunnelName + ".cfargotunnel.com", "muted");
    }

    log("Installing systemd user service…", "info");
    const r4 = await cloudflaredServiceInstall().catch(e => ({ success: false, stderr: String(e) }));
    if (!r4.success) { log("✗ " + r4.stderr, "err"); setBusy(false); return; }
    log("✓ " + r4.stdout, "ok");
    log(`\nJellyfin is now accessible at https://${hostname}`, "info");

    await checkAll();
    setBusy(false);
  };

  const statusColour = { active:"var(--green)", inactive:"var(--muted)", failed:"var(--red)", unknown:"var(--muted)" };
  const statusLabel  = { active:"● Running", inactive:"○ Stopped", failed:"✗ Failed", unknown:"— Unknown" };

  // Step indicator chips at the top
  const steps = [
    { id:"install",   label:"1  Install",   done: installed === true },
    { id:"login",     label:"2  Login",      done: loggedIn  === true },
    { id:"configure", label:"3  Configure",  done: svcStatus === "active" },
    { id:"running",   label:"4  Running",    done: svcStatus === "active" },
  ];

  return (
    <div style={{ maxWidth: 620 }}>
      <h3 style={{ fontWeight: 700, marginBottom: 4 }}>Cloudflare Tunnel — Jellyfin Remote Access</h3>
      <p style={{ color: "var(--muted)", fontSize: 12, marginBottom: 16, lineHeight: 1.6 }}>
        Creates a secure outbound tunnel so you can reach your Jellyfin server from your phone
        or anywhere on the internet — no port forwarding or static IP needed.
        Requires a free <strong style={{ color: "var(--text)" }}>Cloudflare account</strong> and
        a domain managed by Cloudflare.
      </p>

      {/* Step chips */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        {steps.map((st, i) => (
          <div key={st.id} style={{
            padding: "5px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600,
            background: st.done
              ? "rgba(61,220,132,.15)"
              : phase === st.id
                ? "rgba(224,92,42,.15)"
                : "var(--surface2)",
            color: st.done
              ? "var(--green)"
              : phase === st.id
                ? "var(--accent2)"
                : "var(--muted)",
            border: `1px solid ${st.done ? "rgba(61,220,132,.3)" : phase === st.id ? "rgba(224,92,42,.3)" : "var(--border)"}`,
          }}>
            {st.done ? "✓ " : ""}{st.label}
          </div>
        ))}
      </div>

      {/* ── Phase: Install ── */}
      {phase === "install" && (
        <div style={s.col}>
          <div style={{ ...s.card, background: "var(--surface2)" }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>What will be installed</div>
            <p style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
              Downloads the <code style={{ fontFamily: "var(--mono)", color: "var(--blue)" }}>cloudflared</code> binary
              from the official Cloudflare GitHub release into{" "}
              <code style={{ fontFamily: "var(--mono)", color: "var(--blue)" }}>~/.local/bin/</code>.
              No system-wide changes — no sudo required.
            </p>
          </div>
          <Btn onClick={doInstall} disabled={busy}>
            {busy ? <><Spinner/> Downloading…</> : "Install cloudflared"}
          </Btn>
          <Terminal lines={termLines}/>
        </div>
      )}

      {/* ── Phase: Login ── */}
      {phase === "login" && (
        <div style={s.col}>
          <div style={{ ...s.card, background: "var(--surface2)" }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Authenticate with Cloudflare</div>
            <p style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
              Clicking the button below runs{" "}
              <code style={{ fontFamily: "var(--mono)", color: "var(--blue)" }}>cloudflared tunnel login</code>,
              which opens your system browser to the Cloudflare OAuth page.
              Once you approve, a certificate is saved to{" "}
              <code style={{ fontFamily: "var(--mono)", color: "var(--blue)" }}>~/.cloudflared/cert.pem</code> and
              this step completes automatically.
            </p>
          </div>
          <div style={{ background: "rgba(245,197,66,.08)", border: "1px solid rgba(245,197,66,.2)",
            borderRadius: 6, padding: "8px 12px", fontSize: 12, color: "var(--yellow)" }}>
            ⚠ Keep this window open while you authenticate in the browser.
            The button will stay in "Waiting…" state until auth completes.
          </div>
          <Btn onClick={doLogin} disabled={busy}>
            {busy ? <><Spinner/> Waiting for browser auth…</> : "Login to Cloudflare"}
          </Btn>
          <Terminal lines={termLines}/>
        </div>
      )}

      {/* ── Phase: Configure ── */}
      {phase === "configure" && (
        <div style={s.col}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 4 }}>
            <div>
              <div style={s.label}>Tunnel name</div>
              <input style={s.input} value={tunnelName} onChange={e => setTunnelName(e.target.value)}
                placeholder="jellyfin"/>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
                Used internally — one word, no spaces.
              </div>
            </div>
            <div>
              <div style={s.label}>Public hostname (your domain)</div>
              <input style={s.input} value={hostname} onChange={e => setHostname(e.target.value)}
                placeholder="jellyfin.yourdomain.com"/>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
                Must be on a zone managed by Cloudflare.
              </div>
            </div>
          </div>

          <div style={{ ...s.card, background: "rgba(78,166,245,.06)", border: "1px solid rgba(78,166,245,.2)", marginBottom: 0 }}>
            <div style={{ fontSize: 12, color: "var(--blue)", lineHeight: 1.7 }}>
              <strong>What this does:</strong><br/>
              ① Creates a named tunnel in your Cloudflare account<br/>
              ② Writes <code style={{ fontFamily: "var(--mono)" }}>~/.cloudflared/config.yml</code> pointing the tunnel at <code style={{ fontFamily: "var(--mono)" }}>http://localhost:8096</code><br/>
              ③ Attempts to create a DNS CNAME for your hostname (warns if it fails — you can add it manually)<br/>
              ④ Installs a systemd user service that starts the tunnel automatically on login
            </div>
          </div>

          <Btn onClick={doSetup} disabled={busy || !tunnelName || !hostname}>
            {busy ? <><Spinner/> Setting up tunnel…</> : "Create tunnel & start service"}
          </Btn>
          <Terminal lines={termLines}/>
        </div>
      )}

      {/* ── Phase: Running ── */}
      {phase === "running" && (
        <div style={s.col}>
          <div style={{ ...s.card, background: "rgba(61,220,132,.06)", border: "1px solid rgba(61,220,132,.25)" }}>
            <div style={{ ...s.row, marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: statusColour[svcStatus] || statusColour.unknown }}>
                {statusLabel[svcStatus] || statusLabel.unknown}
              </div>
              <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 8 }}>cloudflared-jellyfin</span>
              <Btn variant="ghost" small onClick={checkAll} style={{ marginLeft: "auto" }}>⟳</Btn>
            </div>
            {hostname && (
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                Jellyfin reachable at{" "}
                <strong style={{ color: "var(--text)", fontFamily: "var(--mono)" }}>
                  https://{hostname}
                </strong>
              </div>
            )}
          </div>

          <div style={s.row}>
            {svcStatus !== "active" && (
              <Btn variant="success" onClick={async () => {
                setTermLines([]);
                const r = await cloudflaredServiceStart().catch(e => ({ success: false, stderr: String(e) }));
                log(r.success ? "✓ Tunnel started." : "✗ " + r.stderr, r.success ? "ok" : "err");
                await checkAll();
              }}>Start</Btn>
            )}
            {svcStatus === "active" && (
              <Btn variant="danger" onClick={async () => {
                setTermLines([]);
                const r = await cloudflaredServiceStop().catch(e => ({ success: false, stderr: String(e) }));
                log(r.success ? "✓ Tunnel stopped." : "✗ " + r.stderr, r.success ? "ok" : "err");
                await checkAll();
              }}>Stop</Btn>
            )}
            <Btn variant="ghost" onClick={() => { setPhase("configure"); setTermLines([]); }}>
              Reconfigure →
            </Btn>
          </div>

          <div style={{ ...s.card, background: "var(--surface2)" }}>
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>Troubleshooting</div>
            <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.8 }}>
              <strong style={{ color: "var(--text)" }}>Tunnel not connecting?</strong><br/>
              • Check the service log: <code style={{ fontFamily: "var(--mono)", color: "var(--blue)" }}>journalctl --user -u cloudflared-jellyfin -f</code><br/>
              • Confirm Jellyfin is running on port 8096 in the Jellyfin Server tab<br/>
              • Verify the CNAME exists in your Cloudflare DNS dashboard<br/>
              <strong style={{ color: "var(--text)", marginTop: 4, display: "block" }}>Manual DNS (if auto-routing failed):</strong>
              Add a CNAME record in Cloudflare: <code style={{ fontFamily: "var(--mono)", color: "var(--blue)" }}>{hostname || "jellyfin.yourdomain.com"}</code> →{" "}
              <code style={{ fontFamily: "var(--mono)", color: "var(--blue)" }}>{tunnelName || "jellyfin"}.cfargotunnel.com</code> (Proxied)
            </div>
          </div>

          <Terminal lines={termLines}/>
        </div>
      )}

      {/* Initial check spinner */}
      {phase === "check" && (
        <div style={{ color: "var(--muted)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
          <Spinner/> Checking cloudflared status…
        </div>
      )}
    </div>
  );
}

// ── About page ────────────────────────────────────────────────────────────────

function AboutPage() {
  const sysInfo = React.useContext(SysInfoContext);
  const stats = [
    ["Total apps", APPS.length],
    ["With auto-install", APPS.filter(a=>a.scriptFile||a.flatpakId||a.ujustRecipe).length],
    ["Flatpak", APPS.filter(a=>a.method==="flatpak").length],
    ["GitHub checks", APPS.filter(a=>a.githubRepo).length],
  ];

  const hwRows = sysInfo ? [
    ["CPU",         sysInfo.cpu_model    || "—"],
    ["Threads",     sysInfo.cpu_cores    || "—"],
    ["GPU",         sysInfo.gpu_model    || "—"],
    ["RAM",         sysInfo.ram_total_gb || "—"],
    ["OS",          sysInfo.os_name      || "—"],
    ["OS ID",       sysInfo.os_id        || "—"],
    ["OS Family",   sysInfo.os_family    || "—"],
    ["Pkg Manager", sysInfo.pkg_manager  || "—"],
    ["Kernel",      sysInfo.kernel       || "—"],
    ["Desktop",     sysInfo.desktop      || "—"],
    ["Session",     sysInfo.session_type || "—"],
  ] : [];

  return (
    <div>
      <h2 style={{fontSize:20,fontWeight:700,marginBottom:4}}>About Ignis</h2>
      <p style={{color:"var(--muted)",fontSize:13,marginBottom:20}}>
        Ignis is a native Linux gaming setup tool built with Tauri 2 + React.
        It detects your OS and GPU at startup, then installs and configures the right
        apps the right way for your hardware — no terminal required.
      </p>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
        {stats.map(([l,v]) => (
          <div key={l} style={{...s.card,textAlign:"center"}}>
            <div style={{fontSize:30,fontWeight:800,color:"var(--accent2)"}}>{v}</div>
            <div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>{l}</div>
          </div>
        ))}
      </div>

      <div style={{...s.card,marginBottom:12}}>
        <div style={{fontWeight:700,marginBottom:8}}>
          Detected hardware
          {!sysInfo && <span style={{fontSize:11,color:"var(--muted)",fontWeight:400,marginLeft:8}}>scanning…</span>}
        </div>
        {sysInfo ? (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,fontSize:12}}>
            {hwRows.map(([k,v]) => (
              <div key={k} style={{color:"var(--muted)"}}>
                <span style={{color:"var(--text)",fontWeight:600}}>{k}: </span>
                <span style={{fontFamily:"var(--mono)",fontSize:11}}>{v}</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{color:"var(--muted)",fontSize:12,display:"flex",alignItems:"center",gap:8}}>
            <Spinner/> Scanning hardware…
          </div>
        )}
        {sysInfo?.disk_info?.length > 0 && (
          <div style={{marginTop:10}}>
            <div style={{fontWeight:600,fontSize:12,marginBottom:4}}>Storage</div>
            {sysInfo.disk_info.map((d,i) => (
              <div key={i} style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--muted)"}}>{d}</div>
            ))}
          </div>
        )}
      </div>

      <div style={s.card}>
        <div style={{fontWeight:700,marginBottom:8}}>How version checking works</div>
        <p style={{fontSize:12,color:"var(--muted)",lineHeight:1.7}}>
          Each app with a GitHub repo is checked via the public GitHub Releases API at startup.
          Installed state is detected by querying the Flatpak sandbox or checking PATH.
          The Rust backend runs privileged commands (nmcli, mount, systemctl) via polkit (pkexec)
          for a GUI password prompt — no terminal sudo required.
        </p>
      </div>
    </div>
  );
}


// ── Root App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [page,        setPage]        = useState("apps");
  const [category,    setCategory]    = useState("All");
  const [sysInfo,     setSysInfo]     = useState(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [runSetup,    setRunSetup]    = useState(false);

  // Load system info and check first-run state
  useEffect(() => {
    getSystemInfo().then(setSysInfo).catch(err => {
      console.warn("getSystemInfo failed (expected in browser preview):", err);
    });
    isFirstRun().then(first => {
      if (first) setShowWelcome(true);
    }).catch(() => {});
  }, []);

  const gpuVendor = sysInfo?.gpu_vendor || null;

  const subtitle = sysInfo
    ? [sysInfo.gpu_model, sysInfo.desktop, sysInfo.os_name]
        .filter(Boolean).join(" · ").slice(0, 80)
    : "Detecting hardware…";

  const handleWelcomeDismiss   = () => { setShowWelcome(false); };
  const handleWelcomeRunSetup  = () => { setShowWelcome(false); setRunSetup(true); };

  return (
    <SysInfoContext.Provider value={sysInfo}>
      {showWelcome && (
        <WelcomeScreen
          sysInfo={sysInfo}
          onDismiss={handleWelcomeDismiss}
          onRunSetup={handleWelcomeRunSetup}
        />
      )}

      <div style={s.shell}>
        {/* Top bar */}
        <div style={s.topbar}>
          <div style={{
            ...s.logoBox,
            background:"linear-gradient(135deg,#e05c2a,#c0391a)",
            fontSize:20, letterSpacing:"-1px", fontWeight:900, color:"#fff",
            fontFamily:"var(--mono)",
          }}>ig</div>
          <div>
            <div style={{fontSize:16,fontWeight:800,letterSpacing:"-.5px",
                         background:"linear-gradient(90deg,#f07d4a,#e05c2a)",
                         WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
              Ignis
            </div>
            <div style={{fontSize:11,color:"var(--muted)",maxWidth:600,overflow:"hidden",
                         textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{subtitle}</div>
          </div>
          <div style={{marginLeft:"auto"}}>
            <Btn variant="ghost" small onClick={() => setShowWelcome(true)}>? Help</Btn>
          </div>
        </div>

        <div style={s.body}>
          {/* Sidebar */}
          <div style={s.sidebar}>
            <div style={s.sideSection}>Navigation</div>
            <NavBtn active={page==="apps"}    onClick={()=>setPage("apps")}    icon="📦" label="Apps"/>
            <NavBtn active={page==="network"} onClick={()=>setPage("network")} icon="🌐" label="Network & Media"/>
            <NavBtn active={page==="about"}   onClick={()=>setPage("about")}   icon="ℹ️" label="About"/>

            {page === "apps" && <>
              <div style={s.sideSection}>Filter by category</div>
              {CATEGORIES.map(cat => (
                <NavBtn key={cat} active={category===cat} onClick={() => setCategory(cat)}
                  icon={{All:"🔲",Gaming:"🎮",Emulation:"🕹️",Media:"🎬",System:"⚙️","Streaming & Chat":"📡",Development:"💻"}[cat]||"▪"}
                  label={cat}
                  count={cat==="All" ? APPS.length : APPS.filter(a=>a.category===cat).length}/>
              ))}
            </>}

            {/* OS + GPU info at bottom of sidebar */}
            {(gpuVendor && gpuVendor !== "unknown") || sysInfo?.os_family ? (
              <div style={{marginTop:"auto", padding:"10px 10px 4px"}}>
                {sysInfo?.os_family && (
                  <div style={{marginBottom:6}}>
                    <div style={{fontSize:10,fontWeight:700,letterSpacing:".12em",
                                 color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>OS</div>
                    <div style={{fontSize:11,padding:"4px 8px",borderRadius:5,fontWeight:600,
                                 background:"rgba(78,166,245,.12)",color:"var(--blue)",
                                 border:"1px solid rgba(78,166,245,.3)"}}>
                      {sysInfo.os_family}
                    </div>
                    <div style={{fontSize:10,color:"var(--muted)",marginTop:2,fontFamily:"var(--mono)"}}>
                      {sysInfo.pkg_manager}
                    </div>
                  </div>
                )}
                {gpuVendor && gpuVendor !== "unknown" && (
                  <div>
                    <div style={{fontSize:10,fontWeight:700,letterSpacing:".12em",
                                 color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>GPU</div>
                    <div style={{
                      fontSize:11,padding:"4px 8px",borderRadius:5,fontWeight:600,
                      background: gpuVendor==="amd" ? "rgba(224,92,42,.15)" : gpuVendor==="nvidia" ? "rgba(118,185,0,.15)" : "rgba(78,166,245,.15)",
                      color:      gpuVendor==="amd" ? "var(--accent2)"      : gpuVendor==="nvidia" ? "#76b900"            : "var(--blue)",
                      border:"1px solid currentColor",
                    }}>
                      {gpuVendor.toUpperCase()}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          {/* Main content */}
          <div style={s.main}>
            {page === "apps"    && <AppsPage category={category} setCategory={setCategory} gpuVendor={gpuVendor}/>}
            {page === "network" && <NetworkPage/>}
            {page === "about"   && <AboutPage/>}
          </div>
        </div>
      </div>
    </SysInfoContext.Provider>
  );
}
