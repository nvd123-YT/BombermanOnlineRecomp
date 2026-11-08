// Electron main process for the Bomberman Online launcher.
// Cross-platform: macOS, Windows and Linux. All OS-specific behaviour is
// isolated in the small helpers below; the UI itself is plain HTML/CSS/JS.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { spawn, spawnSync } = require("child_process");

const ROOT = findRepoRoot();
const DC_DIR = process.env.DREAMCOMP_DIR || path.join(ROOT, "dreamcomp");
const LOCAL_JSON = path.join(ROOT, ".dreamcomp", "local.json");
const BINDINGS_DEFAULT = path.join(ROOT, "game", "bindings.txt");
const BINDINGS_USER = path.join(ROOT, ".dreamcomp", "bindings.txt");
const CONFIG = path.join(ROOT, "game", "bomberman_online.toml");
const VMU = path.join(ROOT, ".dreamcomp", "bomberman.vmu");
const CACHE = path.join(ROOT, "build", "CMakeCache.txt");
const EXE = path.join(
  ROOT, "build", "game",
  process.platform === "win32" ? "bomberman-online.exe" : "bomberman-online"
);
const SELFTEST = process.argv.includes("--selftest");

// Walk up from __dirname looking for the port root (game/bomberman_online.toml).
// Handles both dev mode (npm start from tools/launcher) and packaged .app bundles.
function findRepoRoot() {
  let dir = path.resolve(__dirname);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "game", "bomberman_online.toml")))
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Packaged app: resources live in process.resourcesPath (extraResources copies
// dreamcomp/ and game/ there on macOS; Windows/Linux may use resources/app/).
  if (process.resourcesPath) {
    const candidates = [
      process.resourcesPath,
      path.join(process.resourcesPath, "app"),
    ];
    for (const base of candidates) {
      if (fs.existsSync(path.join(base, "game", "bomberman_online.toml")))
        return base;
    }
  }
  // Fallback: __dirname resolved two levels up (dev mode: tools/launcher/../../)
  return path.resolve(__dirname, "..", "..");
}

const DEFAULTS = {
  disc: "",
  resolution: "native",
  vsync: false,
  fullscreen: false,
  fps: false,
  audio: true,
  frames: "600",
  online: false,
  conn: "bba",
  server: "",
  serverPort: "7655",
  dcnet: true,
  scale: 1,
  aspect: "native",
};

const PRESETS = {
  native: { scale: 1, aspect: null, label: "Native" },
  "720p": { scale: 2, aspect: 16 / 9, label: "720p" },
  "1080p": { scale: 3, aspect: 16 / 9, label: "1080p" },
  "1440p": { scale: 4, aspect: 16 / 9, label: "1440p" },
  "4k": { scale: 6, aspect: 16 / 9, label: "4K" },
  "8k": { scale: 8, aspect: 16 / 9, label: "8K" },
};

let win = null;
let child = null;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function readSettings() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(LOCAL_JSON, "utf8"));
  } catch {
    stored = {};
  }
  const s = { ...DEFAULTS, ...stored };
  // Migrate the previous Python launcher schema (display name in "resolution").
  if (!PRESETS[s.resolution]) {
    const byLabel = Object.entries(PRESETS).find(
      ([, p]) => p.label.toLowerCase() === String(s.resolution).toLowerCase()
    );
    if (byLabel) s.resolution = byLabel[0];
    else if (typeof stored.scale === "number") {
      const byScale = Object.entries(PRESETS).find(([, p]) => p.scale === stored.scale);
      s.resolution = byScale ? byScale[0] : "native";
    } else s.resolution = "native";
  }
  if (!["bba", "modem", "pppoe"].includes(s.conn)) s.conn = "bba";
  // scale/aspect are authoritative; derive them once for older settings files.
  if (typeof s.scale !== "number" || s.scale < 1 || s.scale > 8) {
    s.scale = (PRESETS[s.resolution] || PRESETS.native).scale;
  }
  if (!["native", "wide"].includes(s.aspect)) {
    s.aspect = (PRESETS[s.resolution] || PRESETS.native).aspect ? "wide" : "native";
  }
  return s;
}

function writeSettings(patch) {
  const merged = { ...readSettings(), ...patch };
  merged.scale = Math.max(1, Math.min(8, Number(merged.scale) || 1));
  merged.aspect = merged.aspect === "wide" ? "wide" : "native";
  // Keep the display name in sync with the scale where a preset matches.
  const preset = Object.entries(PRESETS).find(([, p]) => p.scale === merged.scale);
  merged.resolution = preset ? preset[0] : "custom";
  try {
    fs.mkdirSync(path.dirname(LOCAL_JSON), { recursive: true });
    fs.writeFileSync(LOCAL_JSON, JSON.stringify(merged, null, 2) + "\n");
  } catch (err) {
    console.error("settings write failed", err);
  }
  return merged;
}

function rendererEnabled() {
  try {
    const text = fs.readFileSync(CACHE, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("DREAM_RENDERER:BOOL=")) {
        return line.split("=")[1].trim().toUpperCase() === "ON";
      }
    }
  } catch {}
  return false;
}

function detectDisc() {
  const dirs = [
    path.join(os.homedir(), "Downloads"),
    path.join(os.homedir(), "Desktop"),
    path.join(os.homedir(), "Documents"),
    ROOT,
  ];
  const exts = new Set([".chd", ".gdi", ".cue", ".cdi"]);
  const found = [];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!exts.has(path.extname(e.name).toLowerCase())) continue;
      const full = path.join(dir, e.name);
      let stat = { size: 0, mtimeMs: 0 };
      try {
        stat = fs.statSync(full);
      } catch {}
      found.push({ full, ...stat });
    }
  }
  if (!found.length) return "";
  found.sort((a, b) => {
    const ab = /bomberman/i.test(a.full) ? 0 : 1;
    const bb = /bomberman/i.test(b.full) ? 0 : 1;
    return ab - bb || b.mtimeMs - a.mtimeMs;
  });
  return found[0].full;
}

// ---------------------------------------------------------------------------
// Toolchain
// ---------------------------------------------------------------------------
function resolvePython() {
  if (process.env.DREAMCOMP_PYTHON) return process.env.DREAMCOMP_PYTHON;
  const win32 = process.platform === "win32";
  const venv = path.join(
    DC_DIR, ".venv", win32 ? "Scripts" : "bin", win32 ? "python.exe" : "python"
  );
  if (fs.existsSync(venv)) return venv;
  // Auto-create a venv in the vendored dreamcomp (packaged app won't have one).
  try {
    spawnSync("python3", ["-m", "venv", path.join(DC_DIR, ".venv")], {
      stdio: "pipe",
    });
    if (fs.existsSync(venv)) return venv;
  } catch {}
  return win32 ? "python" : "python3";
}

function toolEnv(extra = {}) {
  const env = { ...process.env, DREAMCOMP_DIR: DC_DIR, ...extra };
  const win32 = process.platform === "win32";
  const venvBin = path.join(DC_DIR, ".venv", win32 ? "Scripts" : "bin");
  env.PATH = venvBin + path.delimiter + (env.PATH || "");
  if (!env.DCDISC_LIBCHDR) {
    const dylib = path.join(DC_DIR, "build-libchdr", "libchdr.dylib");
    if (fs.existsSync(dylib)) env.DCDISC_LIBCHDR = dylib;
  }
  return env;
}

function dcCommand(args) {
  return { command: resolvePython(), args: [path.join(DC_DIR, "tools", "dc.py"), ...args] };
}

function presetArgs(s) {
  const scale = Math.max(1, Math.min(8, Number(s.scale) || 1));
  const args = [];
  if (scale !== 1) args.push("--scale", String(scale));
  if (s.aspect === "wide") args.push("--render-aspect", (16 / 9).toFixed(4));
  if (s.vsync) args.push("--sync-display");
  if (s.fullscreen) args.push("--fullscreen");
  if (s.fps) args.push("--fps");
  if (!s.audio) args.push("--no-audio");
  if (fs.existsSync(BINDINGS_USER)) args.push("--bindings", BINDINGS_USER);
  if (s.disc) args.push("--disc", s.disc);
  // One card for every run, so a player created in Extras Box survives restarts.
  try {
    fs.mkdirSync(path.dirname(VMU), { recursive: true });
    args.push("--vmu", VMU);
  } catch {}
  return args;
}

function onlineEnv(s) {
  const env = {};
  env.BMO_ONLINE = s.online ? "1" : "0";
  env.BMO_CONN = s.conn || "bba";
  env.BMO_DCNET = s.dcnet === false ? "0" : "1";
  env.BMO_SERVER = s.server || "dcnet.flyca.st";
  env.BMO_SERVER_PORT = String(
    s.serverPort || (s.conn === "modem" ? 7654 : 7655)
  );
  // Frame tracing so we can see DHCP/DNS traffic on the wire.
  if (s.online) env.BMO_DEBUG = "1";
  return env;
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------
function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startProcess(label, command, baseArgs, envPatch = {}, onExit = null) {
  if (child) {
    emit("toast", { kind: "warn", text: "A task is already running." });
    return { ok: false, error: "busy" };
  }
  emit("log", { stream: "cmd", text: `$ ${command} ${baseArgs.join(" ")}` });
  let proc;
  try {
    proc = spawn(command, baseArgs, {
      cwd: ROOT,
      env: toolEnv(envPatch),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    emit("log", { stream: "err", text: String(err) });
    return { ok: false, error: String(err) };
  }
  child = proc;
  emit("task", { running: true, label });

  const pipe = (stream, name) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) emit("log", { stream: name, text: line });
    });
    stream.on("end", () => {
      if (buffer) emit("log", { stream: name, text: buffer });
    });
  };
  pipe(proc.stdout, "out");
  pipe(proc.stderr, "err");

  proc.on("error", (err) => emit("log", { stream: "err", text: String(err) }));
  proc.on("exit", (code, signal) => {
    child = null;
    emit("log", { stream: "meta", text: `${label} exited (${signal || code})` });
    emit("task", { running: false, label, code, signal });
    if (onExit) onExit(code, signal);
  });
  return { ok: true, pid: proc.pid };
}

// dc.py resolves the port's executable by globbing build/game/*, which picks up Makefile on
// macOS/Linux. Builds still go through it; Play launches the known binary directly.
function startChild(label, args, envPatch = {}) {
  const { command, args: baseArgs } = dcCommand(args);
  return startProcess(label, command, baseArgs, envPatch);
}

function stopChild() {
  if (!child) return { ok: false, error: "not running" };
  const pid = child.pid;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
    } else {
      process.kill(-pid, "SIGTERM");
    }
    return { ok: true };
  } catch (err) {
    try {
      child.kill("SIGKILL");
      return { ok: true };
    } catch (err2) {
      return { ok: false, error: String(err2) };
    }
  }
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------
function bindingsPath() {
  return fs.existsSync(BINDINGS_USER) ? BINDINGS_USER : BINDINGS_DEFAULT;
}

function readBindings() {
  try {
    return fs.readFileSync(bindingsPath(), "utf8");
  } catch (err) {
    return `# cannot read bindings: ${err}\n`;
  }
}

function writeBindings(text) {
  try {
    fs.mkdirSync(path.dirname(BINDINGS_USER), { recursive: true });
    fs.writeFileSync(BINDINGS_USER, text);
    return { ok: true, path: BINDINGS_USER };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------
function testConnection(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    if (!host) return resolve({ ok: false, error: "No server host configured" });
    const started = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ...result, ms: Date.now() - started, host, port });
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish({ ok: true }));
    socket.once("timeout", () => finish({ ok: false, error: "timed out" }));
    socket.once("error", (err) => finish({ ok: false, error: err.code || err.message }));
    socket.connect(Number(port) || 7655, host);
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  const isMac = process.platform === "darwin";
  win = new BrowserWindow({
    width: 1120,
    height: 840,
    minWidth: 940,
    minHeight: 700,
    show: false,
    backgroundColor: "#0e1014",
    frame: isMac,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    trafficLightPosition: isMac ? { x: 18, y: 20 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "ui", "index.html"));

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (SELFTEST) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(() => runSelftest(), 900);
    });
  }
}

async function runSelftest() {
  const failures = [];
  let report = null;
  try {
    report = await win.webContents.executeJavaScript("window.__selftest()");
  } catch (err) {
    failures.push(`selftest JS failed: ${err}`);
  }
  if (report && report.failures) failures.push(...report.failures);

  const image = await win.webContents.capturePage();
  const size = image.getSize();
  const bmp = image.getBitmap(); // BGRA
  const seen = new Set();
  let dark = 0;
  let bright = 0;
  let accent = 0;
  let total = 0;
  let sum = 0;
  for (let y = 0; y < size.height; y += 3) {
    for (let x = 0; x < size.width; x += 3) {
      const i = (y * size.width + x) * 4;
      const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
      if (seen.size < 5000) seen.add((r >> 3) << 10 | (g >> 3) << 5 | (b >> 3));
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      sum += lum;
      total++;
      if (lum < 0.22) dark++;
      if (lum > 0.6) bright++;
      if (r > 170 && g < 130 && b < 110) accent++;
    }
  }
  const stats = {
    width: size.width,
    height: size.height,
    uniqueColors: seen.size,
    meanLuminance: +(sum / total).toFixed(3),
    darkRatio: +(dark / total).toFixed(3),
    brightRatio: +(bright / total).toFixed(3),
    accentRatio: +(accent / total).toFixed(4),
  };
  if (stats.uniqueColors < 40) failures.push("capture looks blank (too few colours)");
  if (stats.darkRatio < 0.5) failures.push("background is not dark as designed");
  // CI headless rendering has limited bright pixels; use a lenient threshold.
  const brightThreshold = process.env.CI ? 0.001 : 0.005;
  if (stats.brightRatio < brightThreshold) failures.push("no visible text pixels detected");
  if (stats.accentRatio < 0.0005) failures.push("accent colour not visible");

  const png = path.join(__dirname, "selftest.png");
  try {
    fs.writeFileSync(png, image.toPNG());
  } catch (err) {
    failures.push(`could not save screenshot: ${err}`);
  }

  console.log("SELFTEST_RESULT " + JSON.stringify({ report, stats, failures, screenshot: png }, null, 2));
  app.exit(failures.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function stateSnapshot() {
  const settings = readSettings();
  let discInfo = { exists: false };
  if (settings.disc) {
    try {
      const st = fs.statSync(settings.disc);
      discInfo = {
        exists: true,
        size: st.size,
        name: path.basename(settings.disc),
        dir: path.dirname(settings.disc),
      };
    } catch {
      discInfo = { exists: false, name: path.basename(settings.disc) };
    }
  }
  return {
    platform: process.platform,
    version: app.getVersion(),
    paths: { root: ROOT, exe: EXE, localJson: LOCAL_JSON, bindings: BINDINGS_USER },
    settings,
    discInfo,
    built: fs.existsSync(EXE),
    renderer: rendererEnabled(),
    dcnet: {
      // The engine transport is wired separately; the launcher reports the truth.
      transport: process.env.BMO_DCNET_READY === "1",
    },
    presets: PRESETS,
  };
}

ipcMain.handle("state:get", () => stateSnapshot());
ipcMain.handle("settings:save", (_e, patch) => writeSettings(patch || {}));
ipcMain.handle("disc:pick", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Choose a Dreamcast disc image",
    properties: ["openFile"],
    filters: [
      { name: "Dreamcast images", extensions: ["chd", "gdi", "cue", "cdi"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return res.canceled ? "" : res.filePaths[0];
});
ipcMain.handle("disc:detect", () => detectDisc());
ipcMain.handle("bindings:read", () => ({ text: readBindings(), path: bindingsPath() }));
ipcMain.handle("bindings:defaults", () => {
  try {
    return { text: fs.readFileSync(BINDINGS_DEFAULT, "utf8") };
  } catch (err) {
    return { text: "", error: String(err) };
  }
});
ipcMain.handle("bindings:write", (_e, text) => writeBindings(String(text)));

ipcMain.handle("game:play", (_e, settings) => {
  const s = writeSettings(settings || {});
  if (!fs.existsSync(EXE)) {
    // Auto-build when Play is pressed and the binary is missing.
    emit("toast", { kind: "info", text: "Game binary missing – building first…" });
    return startProcess("build", ["build", "."], {}, (code, signal) => {
      if (code === 0 && fs.existsSync(EXE)) {
        emit("toast", { kind: "info", text: "Build complete – launching game…" });
        startProcess("game", EXE, ["--config", CONFIG, "--window", ...presetArgs(s)], onlineEnv(s));
      } else {
        emit("toast", { kind: "error", text: "Build failed – check logs." });
        emit("log", { stream: "err", text: `Build exited (${signal || code}), game not launched.` });
      }
    });
  }
  if (!rendererEnabled()) {
    return { ok: false, error: "This build was configured headless (DREAM_RENDERER=OFF). Rebuild with Build." };
  }
  if (!s.disc) return { ok: false, error: "Choose a disc image first." };
  if (!fs.existsSync(s.disc)) return { ok: false, error: `Disc not found: ${s.disc}` };
  return startProcess("game", EXE, ["--config", CONFIG, "--window", ...presetArgs(s)],
    onlineEnv(s));
});

ipcMain.handle("game:headless", (_e, settings) => {
  const s = writeSettings(settings || {});
  if (!fs.existsSync(EXE)) return { ok: false, error: "The game binary is missing. Build it first." };
  const frames = /^\d+$/.test(String(s.frames)) ? String(s.frames) : "600";
  const args = ["report", ".", "--frames", frames];
  if (s.disc) args.push("--disc", s.disc);
  return startChild("headless report", args);
});

ipcMain.handle("game:build", () => startChild("build", ["build", "."]));
ipcMain.handle("game:stop", () => stopChild());
ipcMain.handle("net:test", (_e, host, port) => testConnection(host, port));
ipcMain.handle("app:quit", () => {
  if (child) stopChild();
  app.quit();
});
ipcMain.handle("win:minimize", () => win && win.minimize());
ipcMain.handle("win:maximize", () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.handle("win:close", () => win && win.close());

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (child) stopChild();
});
