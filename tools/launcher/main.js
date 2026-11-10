// Electron main process for the Bomberman Online launcher.
// Cross-platform: macOS, Windows and Linux. All OS-specific behaviour is
// isolated in the small helpers below; the UI itself is plain HTML/CSS/JS.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { autoUpdater } = require("electron-updater");

// In dev mode the repository itself is the workspace. A packaged app must not build inside its own
// bundle: Linux AppImages mount read-only, and Program Files / /Applications may not be writable.
// Use a per-user workspace and seed it from the copy bundled with the app.
const BUNDLED_ROOT = findRepoRoot();
const ROOT = app.isPackaged ? path.join(app.getPath("userData"), "workspace") : BUNDLED_ROOT;
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
// dc.py setup writes the boot executable here. Without it the translator has nothing to build,
// so a distributed app that has never seen this machine's disc must extract before building.
const EXTRACTED = path.join(ROOT, "game", "extracted", "fs", "1ST_READ.BIN");
const SELFTEST = process.argv.includes("--selftest");

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


// Walk up from __dirname and process.resourcesPath looking for the port root
// (game/bomberman_online.toml). Handles dev mode and packaged .app bundles
// on all three platforms.
// Walk up from __dirname and process.resourcesPath looking for the port root
// (game/bomberman_online.toml). Handles dev mode and packaged .app bundles
// on all three platforms.
function findRepoRoot() {
  const candidates = [];

  // From process.resourcesPath upwards (packaged .app bundles put extraResources
  // directly into Contents/Resources/ on macOS)
  if (process.resourcesPath) {
    let dir = path.resolve(process.resourcesPath);
    for (let i = 0; i < 10; i++) {
      candidates.push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // From __dirname upwards (dev mode: tools/launcher/../../ or inside .app/Contents/Resources/app/)
  let dir = path.resolve(__dirname);
  for (let i = 0; i < 10; i++) {
    candidates.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Return the first candidate that has BOTH game/bomberman_online.toml AND
  // dreamcomp/tools/dc.py AND CMakeLists.txt (the real repo root).
  for (const candidate of candidates) {
    if (path.basename(candidate) === "launcher") continue;
    if (fs.existsSync(path.join(candidate, "game", "bomberman_online.toml")) &&
        fs.existsSync(path.join(candidate, "dreamcomp", "tools", "dc.py")) &&
        fs.existsSync(path.join(candidate, "CMakeLists.txt"))) {
      return candidate;
    }
  }

  // Fallback: two levels up from __dirname
  return path.resolve(__dirname, "..", "..");
}

// Seed the writable workspace from the copy bundled in the app, once per engine/app build. The
// user's settings, VMU, extracted boot binary and build output live only in the workspace, so
// re-seeding never discards them.
const WORKSPACE_STAMP = path.join(ROOT, ".dreamcomp", "workspace.json");

function bundleStamp() {
  const h = crypto.createHash("sha1");
  h.update(app.getVersion());
  for (const rel of [
    "CMakeLists.txt",
    "game/bomberman_online.toml",
    "src/bomberman_online.cpp",
    "dreamcomp/tools/dc.py",
    "dreamcomp/engine/render/CMakeLists.txt",
    "build/game/bomberman-online",
    "build/game/bomberman-online.exe",
  ]) {
    try {
      h.update(fs.readFileSync(path.join(BUNDLED_ROOT, rel)));
    } catch {}
  }
  return h.digest("hex");
}

function prepareWorkspace() {
  if (!app.isPackaged) return;
  const stamp = bundleStamp();
  try {
    if (JSON.parse(fs.readFileSync(WORKSPACE_STAMP, "utf8")).stamp === stamp) return;
  } catch {}
  fs.mkdirSync(ROOT, { recursive: true });
  // Source trees have no user data in them, so replacing them wholesale is safe.
  for (const name of ["src", "dreamcomp"]) {
    const from = path.join(BUNDLED_ROOT, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(ROOT, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
  }
  for (const name of ["CMakeLists.txt", "README.md", "LICENSE"]) {
    const from = path.join(BUNDLED_ROOT, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(ROOT, name));
  }
  // game/ also holds extracted/ (the user's boot binary), so copy its files individually.
  const gameDir = path.join(ROOT, "game");
  fs.mkdirSync(gameDir, { recursive: true });
  for (const name of ["CMakeLists.txt", "bomberman_online.toml", "symbols.tsv", "bindings.txt"]) {
    const from = path.join(BUNDLED_ROOT, "game", name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(gameDir, name));
  }
  // Ship the prebuilt native game and its adjacent frontend/runtime files into the writable
  // workspace. Only build/game is replaced; settings and VMU saves remain untouched.
  const bundledGameBuild = path.join(BUNDLED_ROOT, "build", "game");
  if (fs.existsSync(bundledGameBuild)) {
    const workspaceGameBuild = path.join(ROOT, "build", "game");
    fs.rmSync(workspaceGameBuild, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(workspaceGameBuild), { recursive: true });
    fs.cpSync(bundledGameBuild, workspaceGameBuild, { recursive: true });
  }
  fs.mkdirSync(path.dirname(WORKSPACE_STAMP), { recursive: true });
  fs.writeFileSync(WORKSPACE_STAMP, JSON.stringify({ stamp, version: app.getVersion() }, null, 2));
  console.log(`workspace seeded at ${ROOT}`);
}

let child = null;

const RELEASES_URL = "https://github.com/nvd123-YT/BombermanOnlineRecomp/releases";
let updaterState = {
  state: "idle",
  message: "Check for updates",
  version: app.getVersion(),
};
let updaterBusy = false;

function setUpdaterState(state, fields = {}) {
  updaterState = { state, version: app.getVersion(), ...fields };
  emit("update-status", updaterState);
}

function configureUpdater() {
  if (!app.isPackaged) {
    setUpdaterState("development", { message: "Updates are available in packaged releases." });
    return;
  }

  // The distributed macOS builds are unsigned. Squirrel.Mac requires a signed application
  // for automatic installation, so keep macOS updates as an explicit release-page download.
  if (process.platform === "darwin") {
    setUpdaterState("manual", { message: "Download the latest macOS build from Releases." });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = true;
  autoUpdater.on("checking-for-update", () => {
    setUpdaterState("checking", { message: "Checking for updates…" });
  });
  autoUpdater.on("update-available", (info) => {
    setUpdaterState("available", {
      message: `Version ${info.version} is available.`,
      availableVersion: info.version,
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    setUpdaterState("current", {
      message: "You have the latest version.",
      availableVersion: info && info.version,
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    setUpdaterState("downloading", {
      message: `Downloading update: ${Math.round(progress.percent)}%`,
      percent: Math.round(progress.percent),
      availableVersion: updaterState.availableVersion,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    setUpdaterState("downloaded", {
      message: `Version ${info.version} is ready to install.`,
      availableVersion: info.version,
    });
  });
  autoUpdater.on("error", (error) => {
    setUpdaterState("error", {
      message: error && error.message ? error.message : String(error),
    });
  });
}

async function performUpdateAction() {
  if (process.platform === "darwin" || !app.isPackaged) {
    await shell.openExternal(RELEASES_URL);
    return { ok: true, manual: true };
  }
  if (updaterBusy) return { ok: false, error: "An update action is already running." };

  try {
    updaterBusy = true;
    if (updaterState.state === "downloaded") {
      if (child) return { ok: false, error: "Close the game before installing the launcher update." };
      autoUpdater.quitAndInstall();
      return { ok: true, installing: true };
    }
    if (updaterState.state === "available") {
      setUpdaterState("downloading", {
        message: "Downloading update…",
        availableVersion: updaterState.availableVersion,
        percent: 0,
      });
      await autoUpdater.downloadUpdate();
      return { ok: true, downloading: true };
    }
    await autoUpdater.checkForUpdates();
    return { ok: true, checking: true };
  } catch (error) {
    setUpdaterState("error", { message: error && error.message ? error.message : String(error) });
    return { ok: false, error: String(error) };
  } finally {
    updaterBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Toolchain
// ---------------------------------------------------------------------------
function resolvePython() {
  if (process.env.DREAMCOMP_PYTHON) return process.env.DREAMCOMP_PYTHON;
  const win32 = process.platform === "win32";
  // Try multiple possible dreamcomp locations for a venv python
  const venvCandidates = [
    path.join(DC_DIR, ".venv"),
    process.resourcesPath && path.join(process.resourcesPath, "dreamcomp", ".venv"),
    process.resourcesPath && path.join(process.resourcesPath, "app", "dreamcomp", ".venv"),
    path.join(__dirname, "..", "..", "dreamcomp", ".venv"),
  ].filter(Boolean);
  for (const venvDir of venvCandidates) {
    const venvPy = path.join(
      venvDir,
      win32 ? "Scripts" : "bin",
      win32 ? "python.exe" : "python"
    );
    if (fs.existsSync(venvPy)) return venvPy;
  }
  // Auto-create a venv in the vendored dreamcomp (packaged app won't have one).
  try {
    const pyCmd = win32 ? "python" : "python3";
    spawnSync(pyCmd, ["-m", "venv", path.join(DC_DIR, ".venv")], {
      stdio: "pipe",
    });
    const venvPy = path.join(
      DC_DIR,
      ".venv",
      win32 ? "Scripts" : "bin",
      win32 ? "python.exe" : "python"
    );
    if (fs.existsSync(venvPy)) return venvPy;
  } catch {}
  return win32 ? "python" : "python3";
}

function toolEnv(extra = {}) {
  const env = { ...process.env, DREAMCOMP_DIR: DC_DIR, ...extra };
  const win32 = process.platform === "win32";
  const venvBin = path.join(DC_DIR, ".venv", win32 ? "Scripts" : "bin");
  env.PATH = venvBin + path.delimiter + (env.PATH || "");
  // Ensure the system CMake on this machine is visible inside the venv sandbox.
  // The Apple CLT cmake lives at a non-default path; fall back to common prefixes.
  const cmakeCandidates = [
    path.join(os.homedir(), ".local", "cmake"),
    "/usr/local",
    "/opt/homebrew",
    "/Library/Developer/CommandLineTools/usr/bin",
  ].filter((p) => fs.existsSync(p));
  if (cmakeCandidates.length) {
    // Add the first existing cmake bin dir to PATH so `cmake` resolves without the user
    // having to manually source env.sh in a packaged app sandbox.
    env.PATH = cmakeCandidates[0] + path.delimiter + env.PATH;
  }
  // A packaged app inherits no shell configuration. Point CMake at the usual per-user toolchain
  // prefixes so find_package(SDL3) works without the user exporting CMAKE_PREFIX_PATH.
  if (!env.CMAKE_PREFIX_PATH) {
    const prefixes =
      process.platform === "darwin"
        ? [path.join(os.homedir(), ".local", "SDL3"), "/opt/homebrew", "/usr/local"]
        : win32
          ? []
          : [path.join(os.homedir(), ".local")];
    const present = prefixes.filter((p) => fs.existsSync(p));
    if (present.length) env.CMAKE_PREFIX_PATH = present.join(path.delimiter);
  }
  if (!env.DCDISC_LIBCHDR) {
    // CHD discs need libchdr; dcdisc also falls back to chdman or a system libchdr. Point it at a
    // local build when there is one, using the platform's shared-library suffix.
    const name =
      process.platform === "win32" ? "chdr.dll"
      : process.platform === "darwin" ? "libchdr.dylib"
      : "libchdr.so";
    for (const dir of [path.join(DC_DIR, "build-libchdr"), path.join(ROOT, "build-libchdr")]) {
      const dylib = path.join(dir, name);
      if (fs.existsSync(dylib)) {
        env.DCDISC_LIBCHDR = dylib;
        break;
      }
    }
  }
  return env;
}

function dcCommand(args) {
  const pyCmd = resolvePython();
  const dcCandidates = [
    path.join(DC_DIR, "tools", "dc.py"),
    process.resourcesPath && path.join(process.resourcesPath, "dreamcomp", "tools", "dc.py"),
    process.resourcesPath && path.join(process.resourcesPath, "app", "dreamcomp", "tools", "dc.py"),
    path.join(__dirname, "..", "..", "dreamcomp", "tools", "dc.py"),
  ].filter(Boolean);
  let dcPy = dcCandidates[0];
  for (const c of dcCandidates) {
    if (fs.existsSync(c)) {
      dcPy = c;
      break;
    }
  }
  return { command: pyCmd, args: [dcPy, ...args] };
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
  // The macOS release carries its Vulkan loader and MoltenVK ICD beside the game executable.
  // Point the child process at that private bundle copy; GUI-launched apps cannot rely on
  // DYLD_LIBRARY_PATH or a system-wide Vulkan SDK installation.
  if (app.isPackaged && process.platform === "darwin") {
    const icd = path.join(path.dirname(EXE), "MoltenVK_icd.json");
    if (fs.existsSync(icd)) env.VK_ICD_FILENAMES = icd;
  }
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
function startChild(label, args, envPatch = {}, onExit = null) {
  const { command, args: baseArgs } = dcCommand(args);
  return startProcess(label, command, baseArgs, envPatch, onExit);
}

// Run dc.py steps one after another (setup -> build), stopping at the first failure. Each step is
// its own child process so its output streams into the log like any other command.
function runDcSteps(steps, done) {
  const step = (i) => {
    if (i >= steps.length) {
      if (done) done();
      return;
    }
    const [label, args, note] = steps[i];
    if (note) emit("toast", { kind: "info", text: note });
    const res = startChild(label, args, {}, (code, signal) => {
      if (code !== 0) {
        emit("toast", { kind: "error", text: `${label} failed – check the log.` });
        emit("log", {
          stream: "err",
          text: `${label} exited (${signal || code}); stopping before launch.`,
        });
        return;
      }
      step(i + 1);
    });
    if (!res.ok) return;
  };
  step(0);
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

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function rendererEnabled() {
  // A packaged release contains a CI-built binary that was verified with the Vulkan renderer.
  // Its CMake cache is intentionally not shipped, so the binary itself is the release marker.
  if (app.isPackaged && fs.existsSync(EXE)) return true;
  // The cache option alone is not enough: the Vulkan backend is skipped when SDL3, Vulkan or
  // glslc are missing, and the resulting game has no window. The built static library is the
  // real evidence, and it also covers a binary built before the current cache existed.
  const dir = path.join(ROOT, "build", "dreamcomp", "engine", "render");
  if (!["libdream_render_vk.a", "dream_render_vk.lib"].some((n) => fs.existsSync(path.join(dir, n)))) {
    return false;
  }
  try {
    const text = fs.readFileSync(CACHE, "utf8");
    const re = new RegExp("\r?\n");
    for (const line of text.split(re)) {
      if (line.startsWith("DREAM_RENDERER:BOOL=")) {
        return line.split("=")[1].trim().toUpperCase() === "ON";
      }
    }
  } catch {}
  return false;
}

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
    updateState: updaterState,
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
ipcMain.handle("app:update-action", () => performUpdateAction());
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
  if (!s.disc) return { ok: false, error: "Choose a disc image first." };
  if (!fs.existsSync(s.disc)) return { ok: false, error: `Disc not found: ${s.disc}` };
  if (!rendererEnabled() && fs.existsSync(EXE)) {
    return {
      ok: false,
      error:
        "This build has no window renderer. Install SDL3 and Vulkan (the Vulkan SDK provides glslc), then press Build.",
    };
  }

  const launch = () => {
    if (!fs.existsSync(EXE)) {
      emit("toast", { kind: "error", text: "Build finished but the game binary is missing – check the log." });
      return;
    }
    if (!rendererEnabled()) {
      emit("toast", {
        kind: "error",
        text: "Built without a window renderer – install SDL3 and Vulkan (glslc), then press Build.",
      });
      return;
    }
    emit("toast", { kind: "info", text: "Launching the game…" });
    startProcess("game", EXE, ["--config", CONFIG, "--disc", s.disc, "--window", ...presetArgs(s)], onlineEnv(s));
  };

  // First Play on a distributed app: the disc has never been extracted here, so the build would
  // be a no-op (dream_add_game returns early without the boot binary). Extract first, then build.
  const steps = [];
  if (!fs.existsSync(EXE)) {
    if (!fs.existsSync(EXTRACTED)) {
      steps.push(["setup", ["setup", ".", "--disc", s.disc],
        "First run: extracting the boot binary from your disc…"]);
    }
    steps.push(["build", ["build", "."], "Building the game – this takes a few minutes…"]);
  }
  if (steps.length) {
    runDcSteps(steps, () => {
      // After build completes, persist that the game is built and has a renderer so the Play
      // button stays clickable on subsequent launches without re-launching the app.
      writeSettings({ built: true, renderer: true, disc: s.disc });
      launch();
    });
    return { ok: true };
  }
  launch();
  return { ok: true };
});

ipcMain.handle("game:headless", (_e, settings) => {
  const s = writeSettings(settings || {});
  if (!fs.existsSync(EXE)) return { ok: false, error: "The game binary is missing. Build it first." };
  const frames = /^\d+$/.test(String(s.frames)) ? String(s.frames) : "600";
  const args = ["report", ".", "--frames", frames];
  if (s.disc) args.push("--disc", s.disc);
  return startChild("headless report", args);
});

ipcMain.handle("game:build", (_e, settings) => {
  const s = writeSettings(settings || {});
  if (app.isPackaged && fs.existsSync(EXE)) {
    return { ok: false, error: "This release already includes the prebuilt game. Select your disc image and press Play; no build is needed." };
  }
  const steps = [];
  if (!fs.existsSync(EXTRACTED)) {
    if (!s.disc) {
      return { ok: false, error: "Choose a disc image first – the boot binary has not been extracted yet." };
    }
    if (!fs.existsSync(s.disc)) return { ok: false, error: `Disc not found: ${s.disc}` };
    steps.push(["setup", ["setup", ".", "--disc", s.disc],
      "Extracting the boot binary from your disc…"]);
  }
  steps.push(["build", ["build", "."], "Building the game – this takes a few minutes…"]);
  runDcSteps(steps);
  return { ok: true };
});
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
  prepareWorkspace();
  configureUpdater();
  createWindow();
  if (app.isPackaged && process.platform !== "darwin") {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((error) => {
        setUpdaterState("error", { message: error && error.message ? error.message : String(error) });
      });
    }, 2500);
  }
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
