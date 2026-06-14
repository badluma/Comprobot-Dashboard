import React, { useEffect, useState, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";

// --- Types ---
type Prim = boolean | string | number;
type ConfigValue = Prim | string[] | Record<string, Prim | string[]>;
type FileData = Record<string, ConfigValue>;

interface BotStatus {
  running: boolean;
  uptime: number | null;
  logs: number;
  errors: number;
  perMinute: {
    t: number; count: number; errors: number; commands: number;
    deleted: number; timeouts: number; kicks: number; bans: number; messages: number;
  }[];
}

interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  discriminator: string;
  avatar: string | null;
  banner: string | null;
  accent_color: number | null;
  banner_color: string | null;
}

interface Guild {
  id: string;
  name: string;
}

// --- Constants ---
const TABS = [
  { label: "Active", file: "active.toml" },
  { label: "Config", file: "config.toml" },
  { label: "AI", file: "ai.toml" },
  { label: "Keywords", file: "keywords.toml" },
  { label: "Descriptions", file: "descriptions.toml" },
  { label: "Output", file: "output.toml" },
  { label: "Moderation", file: "moderation.toml" },
  { label: "Errors", file: "error-messages.toml" },
  { label: "Secrets", file: ".env" },
];

const DEFAULT_STATUS: BotStatus = { running: false, uptime: null, logs: 0, errors: 0, perMinute: [] as BotStatus["perMinute"] };

const LABEL_OVERRIDES: Record<string, string> = {
  qr: "QR", nsfw: "NSFW", ascii: "ASCII", wyr: "Would You Rather", ai: "AI",
};

// --- Helpers ---
function toLabel(key: string): string {
  return key
    .replace(/[-_]/g, " ")
    .split(" ")
    .map((w) => LABEL_OVERRIDES[w.toLowerCase()] ?? w.replace(/^\w/, (c) => c.toUpperCase()))
    .join(" ");
}

function isSection(v: ConfigValue): v is Record<string, Prim | string[]> {
  return typeof v === "object" && !Array.isArray(v) && v !== null;
}

function hasSection(data: FileData): boolean {
  return Object.values(data).some(isSection);
}

// Clean up stale/duplicate entries for display without mutating the underlying file:
//  - .env: collapse case-insensitive duplicate keys (e.g. BOT_TOKEN / bot_token),
//    keeping the canonical UPPERCASE variant.
//  - files with real sections: drop loose top-level primitives left over from an
//    old flat format (the bot reads the sectioned values, so the flat ones are dead).
function normalizeFileData(file: string, data: FileData): FileData {
  if (file === ".env") {
    const seen = new Set<string>();
    const out: FileData = {};
    // Prefer fully-uppercase keys first
    const keys = Object.keys(data).sort((a, b) => {
      const au = a === a.toUpperCase() ? 0 : 1;
      const bu = b === b.toUpperCase() ? 0 : 1;
      return au - bu;
    });
    for (const k of keys) {
      const lc = k.toLowerCase();
      if (seen.has(lc)) continue;
      seen.add(lc);
      out[k] = data[k]!;
    }
    return out;
  }

  if (hasSection(data)) {
    const out: FileData = {};
    for (const [k, v] of Object.entries(data)) {
      if (isSection(v)) out[k] = v;
    }
    return out;
  }

  return data;
}

type InputKind = "toggle" | "text" | "password" | "number" | "textarea" | "array";

function inputKind(key: string, value: Prim | string[], isEnv: boolean): InputKind {
  if (typeof value === "boolean") return "toggle";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "array";
  if (isEnv) return "password";
  if (typeof value === "string" && (value.includes("\n") || value.length > 80)) return "textarea";
  return "text";
}

async function safeFetch<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const text = await r.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // An HTML body means the request fell through to the static page — the
    // dashboard was started without the API server (index.html instead of index.ts).
    if (text.trimStart().startsWith("<")) {
      throw new Error("API server not running — start the dashboard with `bun dev` (runs index.ts), not index.html");
    }
    throw new Error(`Server returned non-JSON response (${r.status})`);
  }
  if (!r.ok) {
    const err = (data as { error?: string })?.error || `HTTP ${r.status}`;
    throw new Error(err);
  }
  return data as T;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function avatarUrl(user: DiscordUser): string {
  if (!user.avatar) {
    const idx = Number(BigInt(user.id) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  }
  const ext = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
}

function bannerUrl(user: DiscordUser): string | null {
  if (!user.banner) return null;
  const ext = user.banner.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/banners/${user.id}/${user.banner}.${ext}?size=480`;
}

function accentCss(user: DiscordUser): string {
  if (user.banner_color) return user.banner_color;
  if (user.accent_color != null) return `#${user.accent_color.toString(16).padStart(6, "0")}`;
  return "#1a1a2e";
}

// --- ANSI Parser ---
const FG: Record<number, string> = {
  30: "#3d3d3d", 31: "#e74c3c", 32: "#2ecc71", 33: "#f1c40f",
  34: "#5dade2", 35: "#9b59b6", 36: "#1abc9c", 37: "#bdc3c7",
  90: "#7f8c8d", 91: "#ff6b6b", 92: "#58d68d", 93: "#f9e79f",
  94: "#85c1e9", 95: "#c39bd3", 96: "#76d7c4", 97: "#ffffff",
};

const BG: Record<number, string> = {
  40: "#000", 41: "#c0392b", 42: "#27ae60", 43: "#d4ac0d",
  44: "#2980b9", 45: "#8e44ad", 46: "#16a085", 47: "#bdc3c7",
};

interface Span { text: string; color?: string; bg?: string; bold?: boolean }

function parseAnsi(raw: string): Span[] {
  // Strip non-SGR escape sequences (cursor movement, etc.)
  const cleaned = raw.replace(/\x1b\[(?:[0-9;]*)[A-HJ-Za-z]/g, (m) =>
    m.endsWith("m") ? m : ""
  );
  const spans: Span[] = [];
  let color: string | undefined;
  let bg: string | undefined;
  let bold = false;

  const parts = cleaned.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (i % 2 === 0) {
      if (part) spans.push({ text: part, color, bg, bold });
    } else {
      const codes = part ? part.split(";").map(Number) : [0];
      for (const code of codes) {
        if (code === 0) { color = undefined; bg = undefined; bold = false; }
        else if (code === 1) bold = true;
        else { const fg = FG[code]; if (fg) color = fg; }
        { const bgc = BG[code]; if (bgc) bg = bgc; }
      }
    }
  }
  return spans;
}

function AnsiLine({ text }: { text: string }) {
  const spans = parseAnsi(text);
  if (spans.length === 0) return <div className="console-line">&nbsp;</div>;
  return (
    <div className="console-line">
      {spans.map((s, i) => (
        <span key={i} style={{ color: s.color, backgroundColor: s.bg, fontWeight: s.bold ? "bold" : undefined }}>
          {s.text}
        </span>
      ))}
    </div>
  );
}

// --- Theme ---
interface ThemeState { bg: string; text: string; accent: string; muted: string }

function Header({ botName, theme, onThemeChange }: {
  botName: string;
  theme: ThemeState;
  onThemeChange: (t: ThemeState) => void;
}) {
  const [colorOpen, setColorOpen] = useState(false);
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!colorOpen) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setColorOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [colorOpen]);

  return (
    <header>
      <div className="logo">
        <svg width="3.853rem" height="3rem" viewBox="0 0 560 436" fill="none">
          <g clipPath="url(#logo-clip)">
            <rect x="378" y="142" width="60" height="152" rx="30" fill="currentColor" />
            <rect x="122" y="142" width="60" height="152" rx="30" fill="currentColor" />
            <rect x="30" y="30" width="500" height="376" rx="106"
              stroke="currentColor" strokeWidth="60" strokeLinejoin="round" />
          </g>
          <defs>
            <clipPath id="logo-clip"><rect width="560" height="436" fill="currentColor" /></clipPath>
          </defs>
        </svg>
        <h1>{botName} Dashboard</h1>
      </div>
      <nav>
        <ul>
          <li ref={ref} className="color-picker-nav">
            <button
              className="color-picker-trigger"
              onClick={() => setColorOpen((o) => !o)}
              aria-label="Theme colors"
            >
              <span className="color-circle" style={{ background: theme.bg, boxShadow: "0 0 0 1px #555" }} />
              <span className="color-circle" style={{ background: theme.text }} />
              <span className="color-circle" style={{ background: theme.accent }} />
              <span className="color-circle" style={{ background: theme.muted }} />
            </button>
            {colorOpen && (
              <div className="color-picker-dropdown">
                <label className="color-picker-item">
                  <input
                    type="color"
                    value={theme.bg}
                    onChange={(e) => onThemeChange({ ...theme, bg: (e.target as HTMLInputElement).value })}
                  />
                  <span>Background</span>
                </label>
                <label className="color-picker-item">
                  <input
                    type="color"
                    value={theme.text}
                    onChange={(e) => onThemeChange({ ...theme, text: (e.target as HTMLInputElement).value })}
                  />
                  <span>Text</span>
                </label>
                <label className="color-picker-item">
                  <input
                    type="color"
                    value={theme.accent}
                    onChange={(e) => onThemeChange({ ...theme, accent: (e.target as HTMLInputElement).value })}
                  />
                  <span>Accent</span>
                </label>
                <label className="color-picker-item">
                  <input
                    type="color"
                    value={theme.muted}
                    onChange={(e) => onThemeChange({ ...theme, muted: (e.target as HTMLInputElement).value })}
                  />
                  <span>Subtle</span>
                </label>
              </div>
            )}
          </li>
          <li><a target="_blank" href="https://github.com/badluma/Comprobot">Repository</a></li>
          <li><a target="_blank" href="https://badluma.github.io/Comprobot-Docs">Documentation</a></li>
        </ul>
      </nav>
    </header>
  );
}

// --- Area / Line Chart (SVG) ---
interface LineDataset {
  label: string;
  color: string;
  values: number[];
}

function smoothLinePath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]!;
    const c = pts[i]!;
    const cpx = (p.x + c.x) / 2;
    d += ` C ${cpx} ${p.y}, ${cpx} ${c.y}, ${c.x} ${c.y}`;
  }
  return d;
}

// Text-free SVG (stretched) for paths/grid only; labels & legend are HTML so they don't distort.
function AreaChart({ lines, xLabels, label }: { lines: LineDataset[]; xLabels: string[]; label: string }) {
  const n = lines[0]?.values.length ?? 0;
  const vw = 1000;
  const vh = 100;
  const pad = 4;
  const cw = vw - pad * 2;
  const ch = vh - pad * 2;

  const maxVal = Math.max(...lines.flatMap((l) => l.values), 1);
  const toX = (i: number) => pad + (n <= 1 ? 0 : (i / (n - 1)) * cw);
  const toY = (v: number) => pad + ch - (v / maxVal) * ch;
  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="chart-wrap">
      <div className="chart-head">
        <p className="chart-label">{label}</p>
        <div className="chart-legend">
          {lines.map((ds) => (
            <span key={ds.label} className="legend-item">
              <span className="legend-swatch" style={{ background: ds.color }} />
              {ds.label}
            </span>
          ))}
        </div>
      </div>

      <div className="chart-plot">
        <svg viewBox={`0 0 ${vw} ${vh}`} preserveAspectRatio="none" className="area-chart">
          {yTicks.map((frac) => (
            <line key={frac}
              x1={pad} y1={pad + ch * (1 - frac)}
              x2={vw - pad} y2={pad + ch * (1 - frac)}
              stroke="#151515" strokeWidth={1}
            />
          ))}
          {lines.map((ds) => {
            const pts = ds.values.map((v, i) => ({ x: toX(i), y: toY(v) }));
            const linePath = smoothLinePath(pts);
            const first = pts[0];
            const last = pts[pts.length - 1];
            const areaPath = first && last
              ? `${linePath} L ${last.x} ${pad + ch} L ${first.x} ${pad + ch} Z`
              : "";
            return (
              <g key={ds.label}>
                {areaPath && <path d={areaPath} fill={ds.color} fillOpacity={0.08} stroke="none" />}
                {linePath && <path d={linePath} fill="none" stroke={ds.color} strokeWidth={1.5}
                  strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
              </g>
            );
          })}
          <line x1={pad} y1={pad + ch} x2={vw - pad} y2={pad + ch} style={{ stroke: "var(--color-muted)" }} strokeWidth={1} />
        </svg>
      </div>

      <div className="chart-xaxis">
        {xLabels.map((lbl, i) => (
          <span key={i} className="xaxis-tick">{lbl}</span>
        ))}
      </div>
    </div>
  );
}

// Darken a hex color by multiplying each channel by factor (0–1).
function darkenHex(hex: string, factor: number): string {
  if (!hex.startsWith("#") || hex.length < 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return "#" + [r, g, b].map((c) => Math.round(c * factor).toString(16).padStart(2, "0")).join("");
}

// Aggregate per-minute telemetry into `points` buckets covering the last `hours` hours.
function buildDatasets(perMinute: BotStatus["perMinute"], hours: number, points: number, accent: string, muted: string): {
  activity: LineDataset[];
  moderation: LineDataset[];
  xLabels: string[];
} {
  const nowMin = Math.floor(Date.now() / 60000);
  const totalMin = hours * 60;
  const minPerPoint = totalMin / points;
  const startMin = nowMin - totalMin;

  const zero = () => Array.from({ length: points }, () => 0);
  const agg = {
    count: zero(), errors: zero(), commands: zero(),
    deleted: zero(), timeouts: zero(), kicks: zero(), bans: zero(), messages: zero(),
  };

  for (const p of perMinute) {
    if (p.t < startMin || p.t > nowMin) continue;
    const idx = Math.min(points - 1, Math.floor((p.t - startMin) / minPerPoint));
    agg.count[idx]! += p.count;
    agg.errors[idx]! += p.errors;
    agg.commands[idx]! += p.commands;
    agg.deleted[idx]! += p.deleted ?? 0;
    agg.timeouts[idx]! += p.timeouts ?? 0;
    agg.kicks[idx]! += p.kicks ?? 0;
    agg.bans[idx]! += p.bans ?? 0;
    agg.messages[idx]! += p.messages ?? 0;
  }

  // Label roughly 6 ticks across the range
  const labelEvery = Math.max(1, Math.round(points / 6));
  const xLabels = Array.from({ length: points }, (_, i) => {
    if (i % labelEvery !== 0 && i !== points - 1) return "";
    const t = startMin + i * minPerPoint;
    const d = new Date(t * 60000);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  });

  return {
    activity: [
      { label: "Commands", color: "#ffffff", values: agg.commands },
      { label: "Log Lines", color: muted, values: agg.count },
      { label: "Errors", color: "#e74c3c", values: agg.errors },
    ],
    moderation: [
      { label: "Messages Sent", color: muted, values: agg.messages },
      { label: "Deleted", color: accent, values: agg.deleted },
      { label: "Timeouts", color: darkenHex(accent, 0.75), values: agg.timeouts },
      { label: "Kicks", color: darkenHex(accent, 0.55), values: agg.kicks },
      { label: "Bans", color: darkenHex(accent, 0.4), values: agg.bans },
    ],
    xLabels,
  };
}

// --- Image preparation ---
// Discord caps profile assets around 10 MB; base64 dataURL must stay under this.
const MAX_IMAGE_B64 = 8 * 1024 * 1024;

// Downscale an image client-side to Discord-friendly dimensions/size.
// Returns a dataURL ready for the Discord API. Animated GIFs are passed
// through untouched when small enough (canvas would drop the animation).
async function prepareImage(file: File, maxW: number, maxH: number): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

  if (file.type === "image/gif" && dataUrl.length <= MAX_IMAGE_B64) return dataUrl;

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Could not read image"));
    i.src = dataUrl;
  });

  const fitsAlready =
    img.width <= maxW && img.height <= maxH &&
    dataUrl.length <= MAX_IMAGE_B64 && file.type !== "image/gif";
  if (fitsAlready) return dataUrl;

  const scale = Math.min(1, maxW / img.width, maxH / img.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  let out = canvas.toDataURL("image/png");
  // Still too big as PNG: step down JPEG quality until it fits.
  for (let q = 0.92; out.length > MAX_IMAGE_B64 && q >= 0.4; q -= 0.12) {
    out = canvas.toDataURL("image/jpeg", q);
  }
  return out;
}

// --- Settings components ---
interface FieldProps {
  file: string;
  section?: string;
  name: string;
  value: Prim | string[];
  onSave: (section: string | undefined, key: string, val: unknown) => Promise<void>;
}

function Field({ file, section, name, value, onSave }: FieldProps) {
  const isEnv = file === ".env";
  const kind = inputKind(name, value, isEnv);
  const initText = Array.isArray(value) ? (value as string[]).join(", ") : String(value);
  const [local, setLocal] = useState(initText);

  useEffect(() => {
    if (kind !== "toggle")
      setLocal(Array.isArray(value) ? (value as string[]).join(", ") : String(value));
  }, [value]);

  const id = `${section ?? "_"}-${name}`;

  if (kind === "toggle") {
    return (
      <div className="setting">
        <p>{toLabel(name)}</p>
        <div className="checkbox-wrapper">
          <input
            type="checkbox"
            id={id}
            checked={value as boolean}
            onChange={(e) => onSave(section, name, (e.target as HTMLInputElement).checked)}
          />
          <label htmlFor={id}></label>
        </div>
      </div>
    );
  }

  if (kind === "textarea") {
    return (
      <div className="setting setting-col">
        <p>{toLabel(name)}</p>
        <textarea
          value={local}
          rows={Math.max(3, local.split("\n").length + 1)}
          onChange={(e) => setLocal((e.target as HTMLTextAreaElement).value)}
          onBlur={() => onSave(section, name, local)}
        />
      </div>
    );
  }

  function commit() {
    if (kind === "number") onSave(section, name, Number(local));
    else if (kind === "array") onSave(section, name, local.split(",").map((s) => s.trim()).filter(Boolean));
    else onSave(section, name, local);
  }

  return (
    <div className="setting">
      <p>{toLabel(name)}</p>
      <input
        type={kind === "password" ? "password" : kind === "number" ? "number" : "text"}
        value={local}
        onChange={(e) => setLocal((e.target as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      />
    </div>
  );
}

interface SectionBlockProps {
  file: string;
  sectionName?: string;
  data: Record<string, Prim | string[]>;
  onSave: (section: string | undefined, key: string, val: unknown) => Promise<void>;
}

function SectionBlock({ file, sectionName, data, onSave }: SectionBlockProps) {
  return (
    <div className="section-group">
      {sectionName && <h3>{toLabel(sectionName)}</h3>}
      {Object.entries(data).map(([key, val]) => (
        <Field key={key} file={file} section={sectionName} name={key}
          value={val as Prim | string[]} onSave={onSave} />
      ))}
    </div>
  );
}

// --- Settings Panel ---
function SettingsPanel({ onSettingsChange }: { onSettingsChange: () => void }) {
  const [activeFile, setActiveFile] = useState<string>(TABS[0]!.file);
  const [data, setData] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    setLoading(true);
    safeFetch<FileData>(`/api/config/${encodeURIComponent(activeFile)}`)
      .then((d) => { setData(normalizeFileData(activeFile, d)); setLoading(false); })
      .catch((e: unknown) => { setError(String(e)); setLoading(false); });
  }, [activeFile]);

  async function handleSave(section: string | undefined, key: string, val: unknown) {
    setData((prev) => {
      if (!prev) return prev;
      if (section) {
        const sec = (prev[section] ?? {}) as Record<string, unknown>;
        return { ...prev, [section]: { ...sec, [key]: val } } as FileData;
      }
      return { ...prev, [key]: val as ConfigValue } as FileData;
    });
    try {
      await safeFetch(`/api/config/${encodeURIComponent(activeFile)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section, key, value: val }),
      });
      onSettingsChange();
    } catch { /* silently ignore save errors */ }
  }

  return (
    <>
      <div className="tab-bar">
        {TABS.map((tab) => (
          <h2
            key={tab.file}
            className={activeFile === tab.file ? "tab-active" : "tab-inactive"}
            onClick={() => setActiveFile(tab.file)}
          >
            {tab.label}
          </h2>
        ))}
      </div>
      <div className="settings-content">
        {loading && <p className="settings-loading">Loading…</p>}
        {error && <p className="settings-error">{error}</p>}
        {data && !loading && (() => {
          if (!hasSection(data)) {
            return <SectionBlock file={activeFile}
              data={data as Record<string, Prim | string[]>} onSave={handleSave} />;
          }
          // Mixed data: render loose top-level keys in one headingless block,
          // then each real section with its heading. Avoids empty <h3> per primitive.
          const flat: Record<string, Prim | string[]> = {};
          const sections: [string, Record<string, Prim | string[]>][] = [];
          for (const [k, v] of Object.entries(data)) {
            if (isSection(v)) sections.push([k, v]);
            else flat[k] = v as Prim | string[];
          }
          return (
            <>
              {Object.keys(flat).length > 0 && (
                <SectionBlock file={activeFile} data={flat} onSave={handleSave} />
              )}
              {sections.map(([sec, secData]) => (
                <SectionBlock key={sec} file={activeFile} sectionName={sec}
                  data={secData} onSave={handleSave} />
              ))}
            </>
          );
        })()}
      </div>
    </>
  );
}

// --- Profile Section ---
interface ProfileProps {
  profile: DiscordUser | null;
  guilds: Guild[];
  botStatus: BotStatus;
  settingsDirty: boolean;
  onBotStart: () => void;
  onStatusRefresh: () => void;
  onProfileUpdate: (u: DiscordUser) => void;
}

function ProfileSection({ profile, guilds, botStatus, settingsDirty, onBotStart, onStatusRefresh, onProfileUpdate }: ProfileProps) {
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<"avatar" | "banner" | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  async function uploadImage(file: File, kind: "avatar" | "banner") {
    const max = kind === "avatar" ? { w: 1024, h: 1024 } : { w: 1920, h: 1080 };
    setUploading(kind);
    try {
      const data = await prepareImage(file, max.w, max.h);
      // Show the new image immediately; the CDN hash can lag behind the API.
      if (kind === "avatar") setAvatarPreview(data);
      else setBannerPreview(data);
      const updated = await safeFetch<DiscordUser>(`/api/discord/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      onProfileUpdate(updated);
    } catch {
      if (kind === "avatar") setAvatarPreview(null);
      else setBannerPreview(null);
    } finally {
      setUploading(null);
    }
  }

  const handleStart = useCallback(async () => {
    setBusy(true);
    await fetch("/api/bot/start", { method: "POST" }).catch(() => {});
    onBotStart();
    setTimeout(onStatusRefresh, 500);
    setBusy(false);
  }, [onBotStart, onStatusRefresh]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    await fetch("/api/bot/stop", { method: "POST" }).catch(() => {});
    setTimeout(onStatusRefresh, 500);
    setBusy(false);
  }, [onStatusRefresh]);

  const handleRestart = useCallback(async () => {
    setBusy(true);
    await fetch("/api/bot/stop", { method: "POST" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    await fetch("/api/bot/start", { method: "POST" }).catch(() => {});
    onBotStart();
    setTimeout(onStatusRefresh, 500);
    setBusy(false);
  }, [onBotStart, onStatusRefresh]);

  async function commitName() {
    setEditingName(false);
    const newName = nameDraft.trim();
    if (!newName || !profile || newName === (profile.global_name ?? profile.username)) return;
    setSavingName(true);
    try {
      await safeFetch("/api/discord/name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newName }),
      });
    } catch { /* rejected by Discord — fall through to re-fetch actual state */ }
    // Don't trust the PATCH echo: re-read the profile so the dashboard only
    // shows the name Discord actually applied.
    try {
      const me = await safeFetch<DiscordUser>("/api/discord/me");
      if (me.id) onProfileUpdate(me);
    } catch { /* ignore */ }
    setSavingName(false);
  }

  const banner = bannerPreview ?? (profile ? bannerUrl(profile) : null);
  const avatar = avatarPreview ?? (profile ? avatarUrl(profile) : null);
  const accent = profile ? accentCss(profile) : "#111";
  const displayName = profile?.global_name ?? profile?.username ?? "Comprobot";
  const tag = profile
    ? (profile.discriminator && profile.discriminator !== "0"
      ? `@${profile.username}#${profile.discriminator}`
      : `@${profile.username}`)
    : null;

  let btnLabel = "Start Bot";
  let btnClass = "bot-btn--start";
  let btnAction = handleStart;

  if (settingsDirty && botStatus.running) {
    btnLabel = "Restart & Apply Changes";
    btnClass = "bot-btn--restart";
    btnAction = handleRestart;
  } else if (botStatus.running) {
    btnLabel = "Stop Bot";
    btnClass = "bot-btn--stop";
    btnAction = handleStop;
  }

  const cameraIcon = (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );

  const pencilIcon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );

  return (
    <div className="profile-section">
      {/* Hidden file inputs */}
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) uploadImage(f, "avatar"); }}
      />
      <input
        ref={bannerInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) uploadImage(f, "banner"); }}
      />

      {/* Banner */}
      <div
        className="profile-banner"
        style={{
          backgroundImage: banner
            ? `url(${banner})`
            : `linear-gradient(135deg, ${accent} 0%, #0a0a0a 100%)`,
        }}
        onClick={() => bannerInputRef.current?.click()}
      >
        <div className="profile-banner-overlay">{cameraIcon}</div>
        {uploading === "banner" && (
          <div className="upload-loading"><span className="spinner" /></div>
        )}
      </div>

      {/* Avatar overlapping the banner */}
      <div className="profile-header">
        <div className="profile-avatar-wrap" onClick={() => avatarInputRef.current?.click()}>
          {avatar
            ? <img src={avatar} alt={displayName} className="profile-avatar" />
            : <div className="profile-avatar profile-avatar-blank" />
          }
          <div className="profile-avatar-overlay">{cameraIcon}</div>
          {uploading === "avatar" && (
            <div className="upload-loading upload-loading--round"><span className="spinner" /></div>
          )}
          <span className={`profile-dot ${botStatus.running ? "profile-dot--on" : "profile-dot--off"}`} />
        </div>
      </div>

      {/* Info */}
      <div className="profile-body">
        <div className="profile-name">
          {editingName ? (
            <input
              className="profile-name-input"
              value={nameDraft}
              autoFocus
              maxLength={32}
              onChange={(e) => setNameDraft((e.target as HTMLInputElement).value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                // Reset the draft first so the blur commit becomes a no-op
                if (e.key === "Escape") {
                  setNameDraft(profile?.global_name ?? profile?.username ?? "");
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          ) : (
            <>
              <span>{displayName}</span>
              <button
                className="name-edit-btn"
                aria-label="Edit bot name"
                onClick={() => { setNameDraft(displayName); setEditingName(true); }}
              >
                {pencilIcon}
              </button>
              {savingName && <span className="spinner spinner--inline" />}
            </>
          )}
        </div>
        {tag && <div className="profile-tag">{tag}</div>}
        <div className="profile-meta">
          <span className="profile-servers">
            {guilds.length} server{guilds.length !== 1 ? "s" : ""}
          </span>
          {botStatus.running && botStatus.uptime != null && (
            <span className="profile-uptime">Up {formatUptime(botStatus.uptime)}</span>
          )}
        </div>

        <button
          className={`bot-btn ${btnClass}`}
          onClick={btnAction}
          disabled={busy}
        >
          {busy ? "…" : btnLabel}
        </button>
      </div>
    </div>
  );
}

// --- Console Tab ---
function ConsoleView({ lines, onClear }: { lines: string[]; onClear: () => void }) {
  const [autoScroll, setAutoScroll] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && endRef.current) {
      endRef.current.scrollIntoView({ behavior: "auto" });
    }
  }, [lines, autoScroll]);

  return (
    <div className="console-view">
      <div className="console-toolbar">
        <span className="console-title">Bot Console</span>
        <span className="console-autoscroll-text">Auto-scroll</span>
        <div className="checkbox-wrapper checkbox-wrapper--small">
          <input
            type="checkbox"
            id="console-autoscroll"
            checked={autoScroll}
            onChange={(e) => setAutoScroll((e.target as HTMLInputElement).checked)}
          />
          <label htmlFor="console-autoscroll"></label>
        </div>
        <button className="console-clear-btn" onClick={onClear}>Clear</button>
      </div>
      <div className="console-output" ref={containerRef}>
        {lines.length === 0
          ? <div className="console-empty">Start the bot to see console output.</div>
          : lines.map((line, i) => <AnsiLine key={i} text={line} />)
        }
        <div ref={endRef} />
      </div>
    </div>
  );
}

// --- Stats Tab ---
function StatsView({ botStatus, guildCount, theme }: { botStatus: BotStatus; guildCount: number; theme: ThemeState }) {
  const { activity, moderation, xLabels } = buildDatasets(botStatus.perMinute, 24, 24, theme.accent, theme.muted);

  const stats: { label: string; value: string; accent?: string }[] = [
    { label: "Servers", value: String(guildCount) },
    {
      label: "Status",
      value: botStatus.running ? "Online" : "Offline",
      accent: botStatus.running ? "#2ecc71" : "#e74c3c",
    },
    {
      label: "Uptime",
      value: botStatus.running && botStatus.uptime != null ? formatUptime(botStatus.uptime) : "—",
    },
    { label: "Log Lines", value: String(botStatus.logs) },
    {
      label: "Errors",
      value: String(botStatus.errors),
      accent: botStatus.errors > 0 ? "#e74c3c" : undefined,
    },
  ];

  return (
    <div className="stats-view">
      <div className="stats-charts">
        <AreaChart lines={activity} xLabels={xLabels} label="Command Activity — last 24h" />
        <AreaChart lines={moderation} xLabels={xLabels} label="Moderation — last 24h" />
      </div>
      <div className="stats-sidebar">
        {stats.map((s) => (
          <div key={s.label} className="stat-card">
            <span className="stat-value" style={{ color: s.accent }}>{s.value}</span>
            <span className="stat-label">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Analytics Section ---
function AnalyticsSection({ botStatus, guilds, theme }: { botStatus: BotStatus; guilds: Guild[]; theme: ThemeState }) {
  const [tab, setTab] = useState<"stats" | "console">("stats");
  const [lines, setLines] = useState<string[]>([]);
  const clearedRef = useRef(false);

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/api/ws`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as { type: string; data: string | string[] };
      if (msg.type === "history") {
        if (!clearedRef.current) {
          setLines((msg.data as string[]).filter((l) => l !== ""));
        }
      } else if (msg.type === "log") {
        setLines((prev) => {
          const next = [...prev, msg.data as string];
          return next.length > 2000 ? next.slice(-2000) : next;
        });
      }
    };
    return () => ws.close();
  }, []);

  const handleClear = useCallback(() => {
    clearedRef.current = true;
    setLines([]);
  }, []);

  return (
    <div className="analytics-section">
      <div className="tab-bar analytics-tab-bar">
        <h2 className={tab === "stats" ? "tab-active" : "tab-inactive"} onClick={() => setTab("stats")}>Stats</h2>
        <h2 className={tab === "console" ? "tab-active" : "tab-inactive"} onClick={() => setTab("console")}>Console</h2>
      </div>
      <div className="analytics-body">
        {tab === "stats"
          ? <StatsView botStatus={botStatus} guildCount={guilds.length} theme={theme} />
          : <ConsoleView lines={lines} onClear={handleClear} />
        }
      </div>
    </div>
  );
}

// --- App ---
function App() {
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [profile, setProfile] = useState<DiscordUser | null>(null);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [botStatus, setBotStatus] = useState<BotStatus>(DEFAULT_STATUS);
  const [theme, setTheme] = useState<ThemeState>(() => {
    try {
      const saved = localStorage.getItem("dashboard-theme");
      if (saved) return JSON.parse(saved) as ThemeState;
    } catch { /* ignore */ }
    return { bg: "#000000", text: "#ffffff", accent: "#2ecc71", muted: "#444444" };
  });

  useEffect(() => {
    const s = document.documentElement.style;
    s.setProperty("--color-bg", theme.bg);
    s.setProperty("--color-text", theme.text);
    s.setProperty("--color-accent", theme.accent);
    s.setProperty("--color-muted", theme.muted);
    try { localStorage.setItem("dashboard-theme", JSON.stringify(theme)); } catch { /* ignore */ }
  }, [theme]);

  const botName = profile?.global_name ?? profile?.username ?? "Comprobot";

  useEffect(() => {
    document.title = `${botName} Dashboard`;
  }, [botName]);

  const refreshStatus = useCallback(() => {
    fetch("/api/bot/status")
      .then((r) => r.json())
      .then((d: unknown) => setBotStatus(d as BotStatus))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/discord/me")
      .then((r) => r.json())
      .then((d: unknown) => { if ((d as { id?: string }).id) setProfile(d as DiscordUser); })
      .catch(() => {});

    fetch("/api/discord/guilds")
      .then((r) => r.json())
      .then((d: unknown) => { if (Array.isArray(d)) setGuilds(d as Guild[]); })
      .catch(() => {});

    refreshStatus();
    const interval = setInterval(refreshStatus, 3000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  return (
    <>
      <Header botName={botName} theme={theme} onThemeChange={setTheme} />
      <main>
        <div className="app-layout">
          <div className="panel-left">
            <div className="section1">
              <SettingsPanel onSettingsChange={() => setSettingsDirty(true)} />
            </div>
          </div>
          <div className="panel-right">
            <div className="section2">
              <ProfileSection
                profile={profile}
                guilds={guilds}
                botStatus={botStatus}
                settingsDirty={settingsDirty}
                onBotStart={() => setSettingsDirty(false)}
                onStatusRefresh={refreshStatus}
                onProfileUpdate={setProfile}
              />
            </div>
            <div className="section3">
              <AnalyticsSection botStatus={botStatus} guilds={guilds} theme={theme} />
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

// Mount — use singleton root to avoid HMR double-mount warning
declare global { interface Window { __dashRoot?: ReturnType<typeof createRoot> } }
const container = document.getElementById("app-root") ?? document.getElementById("settings-root");
if (container) {
  if (!window.__dashRoot) window.__dashRoot = createRoot(container);
  window.__dashRoot.render(<App />);
}
