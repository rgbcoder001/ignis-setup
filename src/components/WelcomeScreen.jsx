// src/components/WelcomeScreen.jsx
// Shown on first launch (empty install log). Orients the user,
// confirms detected hardware, and offers a one-click full setup.

import React, { useState } from "react";
import { Btn, Spinner, s } from "./ui.jsx";
import { isSteamRunning } from "../lib/tauri.js";

const OS_LABEL = {
  "fedora-atomic": { name:"Bazzite / Fedora Atomic", colour:"var(--accent2)", note:"Full support — all features available." },
};

const GPU_LABEL = {
  "amd":     { name:"AMD",    colour:"var(--accent2)", note:"All GPU-specific features fully supported." },
  "nvidia":  { name:"NVIDIA", colour:"#76b900",        note:"All features work. Some may need extra driver setup." },
  "intel":   { name:"Intel",  colour:"var(--blue)",    note:"All features work. Fan control limited on Arc." },
  "unknown": { name:"Unknown GPU", colour:"var(--muted)", note:"GPU-specific features may not be detected correctly." },
};

export default function WelcomeScreen({ sysInfo, onDismiss, onRunSetup }) {
  const [step, setStep] = useState(0); // 0=intro, 1=hardware confirm, 2=ready

  const osKey = sysInfo?.os_family || "unknown";
  const gpuKey = sysInfo?.gpu_vendor || "unknown";
  const osInfo  = OS_LABEL[osKey]  || { name: sysInfo?.os_name || "Linux", colour:"var(--muted)", note:"Support level unknown." };
  const gpuInfo = GPU_LABEL[gpuKey] || GPU_LABEL["unknown"];

  const HwRow = ({ label, value, colour, note }) => (
    <div style={{ ...s.card, background:"var(--surface2)", padding:"12px 14px" }}>
      <div style={{ ...s.row, marginBottom:4 }}>
        <span style={{ fontSize:11, color:"var(--muted)", fontWeight:700, textTransform:"uppercase",
                       letterSpacing:".08em", width:60, flexShrink:0 }}>{label}</span>
        <span style={{ fontSize:13, fontWeight:700, color: colour }}>{value}</span>
      </div>
      <p style={{ fontSize:11, color:"var(--muted)", lineHeight:1.5, marginLeft:68 }}>{note}</p>
    </div>
  );

  return (
    <div style={{ position:"fixed", inset:0, background:"var(--bg)", zIndex:200,
                  display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ width:560, ...s.col, gap:0 }}>

        {/* ── Step 0: Intro ──────────────────────────────────────────── */}
        {step === 0 && (
          <>
            <div style={{ textAlign:"center", marginBottom:32 }}>
              <div style={{
                width:64, height:64, borderRadius:16, margin:"0 auto 16px",
                background:"linear-gradient(135deg,#e05c2a,#c0391a)",
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:28, fontWeight:900, color:"#fff", fontFamily:"var(--mono)",
                letterSpacing:"-2px",
              }}>ig</div>
              <h1 style={{ fontSize:26, fontWeight:800, letterSpacing:"-.5px", marginBottom:8,
                           background:"linear-gradient(90deg,#f07d4a,#e05c2a)",
                           WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
                Welcome to Ignis
              </h1>
              <p style={{ fontSize:14, color:"var(--muted)", lineHeight:1.7, maxWidth:420, margin:"0 auto" }}>
                A Linux gaming setup tool. Detects your hardware and installs
                everything the right way for your system — no terminal required.
              </p>
            </div>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:28 }}>
              {[
                ["🎮", "Gaming apps",    "GE-Proton, DLSS, OptiScaler, Heroic"],
                ["🎬", "Media apps",     "mpv, HandBrake, Jellyfin server"],
                ["📡", "Streaming",      "OBS Studio, Discord (fully configured)"],
                ["🌐", "Network",        "Static IP, NAS mount, Jellyfin migration"],
              ].map(([icon, title, desc]) => (
                <div key={title} style={{ ...s.card, background:"var(--surface2)", padding:"12px 14px" }}>
                  <div style={{ fontSize:20, marginBottom:6 }}>{icon}</div>
                  <div style={{ fontWeight:700, fontSize:13, marginBottom:3 }}>{title}</div>
                  <p style={{ fontSize:11, color:"var(--muted)", lineHeight:1.5 }}>{desc}</p>
                </div>
              ))}
            </div>

            <div style={{ ...s.row, justifyContent:"flex-end" }}>
              <Btn variant="ghost" onClick={onDismiss}>Skip intro</Btn>
              <Btn onClick={() => setStep(1)}>Next: confirm hardware →</Btn>
            </div>
          </>
        )}

        {/* ── Step 1: Hardware confirm ───────────────────────────────── */}
        {step === 1 && (
          <>
            <div style={{ marginBottom:20 }}>
              <h2 style={{ fontSize:20, fontWeight:700, marginBottom:4 }}>Your detected hardware</h2>
              <p style={{ fontSize:13, color:"var(--muted)", lineHeight:1.6 }}>
                Ignis tailors every install to your specific OS and GPU.
                Confirm the detection is correct before continuing.
              </p>
            </div>

            <div style={{ ...s.col, gap:8, marginBottom:20 }}>
              <HwRow label="OS"     value={osInfo.name}                       colour={osInfo.colour}  note={osInfo.note} />
              <HwRow label="GPU"    value={sysInfo?.gpu_model || gpuInfo.name} colour={gpuInfo.colour} note={gpuInfo.note} />
              <HwRow label="CPU"    value={sysInfo?.cpu_model || "—"}          colour="var(--text)"    note={sysInfo?.cpu_cores || ""} />
              <HwRow label="RAM"    value={sysInfo?.ram_total_gb || "—"}        colour="var(--text)"    note="" />
            </div>

            {osKey === "unknown" && (
              <div style={{ background:"rgba(245,197,66,.08)", border:"1px solid rgba(245,197,66,.25)",
                            borderRadius:6, padding:"10px 14px", fontSize:12, color:"var(--yellow)",
                            lineHeight:1.6, marginBottom:16 }}>
                ⚠ Your OS could not be identified. Some install methods may fall back to Flatpak.
                The tool will still work — it will just use the most compatible method available.
              </div>
            )}

            <div style={{ ...s.row, justifyContent:"space-between" }}>
              <Btn variant="ghost" onClick={() => setStep(0)}>← Back</Btn>
              <div style={{ ...s.row }}>
                <Btn variant="ghost" onClick={onDismiss}>Skip to app list</Btn>
                <Btn onClick={() => setStep(2)}>Looks good →</Btn>
              </div>
            </div>
          </>
        )}

        {/* ── Step 2: Ready ─────────────────────────────────────────── */}
        {step === 2 && (
          <>
            <div style={{ marginBottom:20 }}>
              <h2 style={{ fontSize:20, fontWeight:700, marginBottom:4 }}>Ready to set up</h2>
              <p style={{ fontSize:13, color:"var(--muted)", lineHeight:1.6 }}>
                You can run the full setup now (installs everything at once) or
                browse the app list and install things individually at your own pace.
              </p>
            </div>

            <div style={{ ...s.col, gap:8, marginBottom:24 }}>
              {/* Full setup option */}
              <label style={{ ...s.card, cursor:"pointer", padding:"16px",
                              background:"rgba(224,92,42,.06)", border:"1px solid var(--accent)" }}>
                <div style={{ fontWeight:700, fontSize:14, marginBottom:4 }}>⚙ Run full setup</div>
                <p style={{ fontSize:12, color:"var(--muted)", lineHeight:1.55 }}>
                  Installs all apps in one go: mpv, GE-Proton, DLSS Updater, OptiScaler,
                  HandBrake, OBS Studio, Discord, and EmuDeck.
                  Takes about 5–10 minutes depending on your connection.
                </p>
              </label>

              {/* Browse option */}
              <label style={{ ...s.card, cursor:"pointer", padding:"16px" }}>
                <div style={{ fontWeight:700, fontSize:14, marginBottom:4 }}>📦 Browse and pick</div>
                <p style={{ fontSize:12, color:"var(--muted)", lineHeight:1.55 }}>
                  Go to the app list and install only what you want.
                  Each app shows its OS and GPU compatibility before you install.
                </p>
              </label>
            </div>

            <div style={{ ...s.row, justifyContent:"space-between" }}>
              <Btn variant="ghost" onClick={() => setStep(1)}>← Back</Btn>
              <div style={{ ...s.row }}>
                <Btn variant="ghost" onClick={onDismiss}>Browse apps instead</Btn>
                <Btn onClick={onRunSetup}>Run full setup</Btn>
              </div>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
