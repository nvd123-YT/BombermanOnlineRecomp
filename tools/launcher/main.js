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

// RecompLauncher normally substitutes {game} into --game. Keep an environment
// fallback for launch hosts that do not preserve custom process arguments.
function suppliedRecompLauncherDisc(argv = process.argv, env = process.env) {
  const flags = ["--game", "--disc", "--iso"];
  for (let i = 0; i < argv.length; i++) {
    const argument = String(argv[i] ?? "");
    for (const flag of flags) {
      if (argument.startsWith(`${flag}=`)) {
        const value = argument.slice(flag.length + 1).trim();
        if (value) return value;
      }
      if (argument === flag) {
        const value = String(argv[i + 1] ?? "").trim();
        if (value && !value.startsWith("--")) return value;
      }
    }
  }

  return typeof env.BMO_RECOMP_DISC === "string" ? env.BMO_RECOMP_DISC.trim() : "";
}
let selftestWatchdog = null;

if (SELFTEST) {
  process.on("unhandledRejection", (reason) => {
    console.error(`SELFTEST_UNHANDLED_REJECTION ${reason && (reason.stack || reason)}`);
    app.exit(1);
  });
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
  "720p": { scale: 1.5, aspect: 16 / 9, label: "720p" },
  "1080p": { scale: 2.25, aspect: 16 / 9, label: "1080p" },
  "1440p": { scale: 3, aspect: 16 / 9, label: "1440p" },
  "4k": { scale: 4.5, aspect: 16 / 9, label: "4K" },
  "8k": { scale: 9, aspect: 16 / 9, label: "8K" },
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
    // Include adjacent platform runtimes in the stamp so updated DLLs refresh
    // the writable workspace even when the native game executable is unchanged.
    "build/game/vulkan-1.dll",
    "build/game/libgcc_s_seh-1.dll",
    "build/game/libstdc++-6.dll",
    "build/game/libwinpthread-1.dll",
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

let win = null;
let child = null;

const RELEASES_URL = "https://github.com/nvd123-YT/BombermanOnlineRecomp/releases";
const RELEASES_API = "https://api.github.com/repos/nvd123-YT/BombermanOnlineRecomp/releases?per_page=30";
const UPDATE_CHECKSUM_ASSET = "SHA256SUMS.txt";
const BUILD_INFO_PATH = path.join(__dirname, "build-info.json");
let BUILD_INFO = { tag: "development", commit: "" };
try {
  const candidate = JSON.parse(fs.readFileSync(BUILD_INFO_PATH, "utf8"));
  if (candidate && typeof candidate === "object") BUILD_INFO = { ...BUILD_INFO, ...candidate };
} catch {}

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

function httpsBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("Too many redirects while contacting GitHub."));
    const target = new URL(url);
    const req = require("https").get(target, {
      headers: {
        "User-Agent": "BombermanOnlineLauncher-Updater/1.0",
        "Accept": "application/vnd.github+json",
        "Cache-Control": "no-cache",
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        httpsBuffer(new URL(res.headers.location, target).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GitHub request failed with HTTP ${res.statusCode || "unknown"}.`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error("GitHub request timed out.")));
    req.on("error", reject);
  });
}

function downloadUpdateAsset(url, destination, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("Too many redirects while downloading the update."));
    const target = new URL(url);
    let output = null;
    let response = null;
    let settled = false;

    const removePartial = () => {
      try { fs.rmSync(destination, { force: true }); } catch {}
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (response && output) response.unpipe(output);
      if (output && !output.closed) {
        output.once("close", removePartial);
        output.destroy();
      } else {
        removePartial();
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const req = require("https").get(target, {
      headers: { "User-Agent": "BombermanOnlineLauncher-Updater/1.0" },
    }, (res) => {
      response = res;
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        downloadUpdateAsset(new URL(res.headers.location, target).toString(), destination, options, redirects + 1)
          .then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`Update download failed with HTTP ${res.statusCode || "unknown"}.`));
        return;
      }

      const headerBytes = Number(res.headers["content-length"]) || 0;
      const totalBytes = headerBytes || Number(options.expectedBytes) || 0;
      let receivedBytes = 0;
      output = fs.createWriteStream(destination, { flags: "wx" });
      output.on("error", fail);
      res.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (typeof options.onProgress === "function") {
          try {
            options.onProgress(receivedBytes, totalBytes);
          } catch (error) {
            fail(error);
          }
        }
      });
      res.on("aborted", () => fail(new Error("The update download was interrupted before it completed.")));
      res.on("error", fail);
      output.on("finish", () => {
        output.close((error) => {
          if (error) return fail(error);
          if (settled) return;
          settled = true;
          resolve({ path: destination, bytes: receivedBytes, totalBytes });
        });
      });
      res.pipe(output);
    });
    req.setTimeout(45000, () => req.destroy(new Error("No data received for 45 seconds; the update download stalled.")));
    req.on("error", fail);
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function updateAssetSuffix() {
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "";
    if (!arch) throw new Error(`Unsupported macOS architecture: ${process.arch}`);
    return `-mac-${arch}.zip`;
  }
  if (process.platform === "win32") return "-win-x64.exe";
  if (process.platform === "linux" && process.env.APPIMAGE) return "-linux-x64.AppImage";
  return "";
}

async function findLatestRelease() {
  const suffix = updateAssetSuffix();
  if (!suffix) return null;
  const response = JSON.parse((await httpsBuffer(RELEASES_API)).toString("utf8"));
  if (!Array.isArray(response)) throw new Error("GitHub returned an invalid release list.");
  const eligible = response
    .filter((release) => !release.draft && Array.isArray(release.assets))
    .filter((release) => release.assets.some((asset) => asset.name === UPDATE_CHECKSUM_ASSET))
    .filter((release) => release.assets.some((asset) => asset.name.endsWith(suffix)))
    .sort((a, b) => String(b.published_at || b.created_at).localeCompare(
      String(a.published_at || a.created_at)
    ));
  return eligible[0] || null;
}

function checksumForAsset(text, filename) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === filename) return match[1].toLowerCase();
  }
  throw new Error(`Release checksum list is missing ${filename}.`);
}

function findMacAppBundle() {
  let dir = path.resolve(process.resourcesPath || __dirname);
  for (let i = 0; i < 10; i++) {
    if (dir.toLowerCase().endsWith(".app") && fs.existsSync(path.join(dir, "Contents", "Info.plist"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate the installed Bomberman Online Launcher.app bundle.");
}

async function performUpdateAction() {
  if (updaterBusy) return { ok: false, error: "An update action is already running." };
  if (!app.isPackaged) {
    await shell.openExternal(RELEASES_URL);
    setUpdaterState("development", { message: "Install a packaged release to use in-app updates." });
    return { ok: true, manual: true };
  }
  if (child) return { ok: false, error: "Close Bomberman Online before updating the launcher." };

  const suffix = updateAssetSuffix();
  if (!suffix) {
    await shell.openExternal(RELEASES_URL);
    setUpdaterState("manual", { message: "Download the Linux .deb or .tar.gz manually; AppImage installs can update here." });
    return { ok: true, manual: true };
  }

  try {
    updaterBusy = true;
    if (updaterState.state !== "available" || !updaterState.release) {
      setUpdaterState("checking", { message: "Checking GitHub Releases…" });
      const release = await findLatestRelease();
      if (!release) throw new Error("No compatible release with a SHA-256 manifest was found.");
      if (release.tag_name === BUILD_INFO.tag) {
        setUpdaterState("current", { message: "You have the latest build.", releaseTag: release.tag_name });
        return { ok: true, current: true };
      }
      const asset = release.assets.find((item) => item.name.endsWith(suffix));
      const manifestAsset = release.assets.find((item) => item.name === UPDATE_CHECKSUM_ASSET);
      setUpdaterState("available", {
        message: `Build ${release.name || release.tag_name} is available.`,
        availableVersion: release.name || release.tag_name,
        releaseTag: release.tag_name,
        release,
      });
      return { ok: true, available: true };
    }

    const release = updaterState.release;
    const asset = release.assets.find((item) => item.name.endsWith(suffix));
    const manifestAsset = release.assets.find((item) => item.name === UPDATE_CHECKSUM_ASSET);
    if (!asset || !manifestAsset) throw new Error("The selected release is missing its platform package or checksum manifest.");

    const releaseLabel = release.name || release.tag_name;
    setUpdaterState("downloading", {
      message: "Preparing update download…",
      stage: "package",
      percent: 0,
      downloadedBytes: 0,
      totalBytes: Number(asset.size) || 0,
      availableVersion: releaseLabel,
      releaseTag: release.tag_name,
    });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bomberman-online-update-"));
    const archivePath = path.join(tempDir, path.basename(asset.name));
    const checksumPath = path.join(tempDir, UPDATE_CHECKSUM_ASSET);
    try {
      let lastProgressAt = 0;
      await downloadUpdateAsset(asset.browser_download_url, archivePath, {
        expectedBytes: Number(asset.size) || 0,
        onProgress: (received, total) => {
          const now = Date.now();
          if (now - lastProgressAt < 120 && (!total || received < total)) return;
          lastProgressAt = now;
          const expected = total || Number(asset.size) || 0;
          setUpdaterState("downloading", {
            message: "Downloading update package…",
            stage: "package",
            percent: expected ? Math.min(100, Math.floor(received * 100 / expected)) : null,
            downloadedBytes: received,
            totalBytes: expected,
            availableVersion: releaseLabel,
            releaseTag: release.tag_name,
          });
        },
      });
      setUpdaterState("downloading", {
        message: "Downloading checksum manifest…",
        stage: "checksum",
        percent: null,
        downloadedBytes: 0,
        totalBytes: 0,
        availableVersion: releaseLabel,
        releaseTag: release.tag_name,
      });
      await downloadUpdateAsset(manifestAsset.browser_download_url, checksumPath);
      setUpdaterState("verifying", {
        message: "Verifying update checksum…",
        availableVersion: releaseLabel,
        releaseTag: release.tag_name,
      });
      const checksumText = fs.readFileSync(checksumPath, "utf8");
      const expected = checksumForAsset(checksumText, asset.name);
      const actual = await sha256File(archivePath);
      if (actual !== expected) throw new Error("SHA-256 verification failed. The update will not be installed.");

      const choice = await dialog.showMessageBox(win, {
        type: "info",
        buttons: ["Install and restart", "Later"],
        defaultId: 0,
        cancelId: 1,
        title: "Bomberman Online Launcher Update",
        message: `Build ${release.name || release.tag_name} is downloaded and verified.`,
        detail: "The launcher will close, install the update, and reopen. Your disc selection, settings, bindings, and VMU save are stored separately and will be kept.",
      });
      if (choice.response !== 0) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        setUpdaterState("available", {
          message: "Update is available. Click again when you are ready to install.",
          availableVersion: release.name || release.tag_name,
          releaseTag: release.tag_name,
          release,
        });
        return { ok: true, available: true };
      }

      const pid = String(process.pid);
      if (process.platform === "darwin") {
        const appBundle = findMacAppBundle();
        const helper = path.join(tempDir, "update-macos.sh");
        fs.copyFileSync(path.join(__dirname, "update-macos.sh"), helper);
        const proc = spawn("/bin/bash", [helper, appBundle, archivePath, pid, tempDir], {
          detached: true, stdio: "ignore",
        });
        proc.unref();
      } else if (process.platform === "win32") {
        const helper = path.join(tempDir, "update-windows.ps1");
        fs.copyFileSync(path.join(__dirname, "update-windows.ps1"), helper);
        const proc = spawn("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", helper, "-Installer", archivePath,
          "-ParentPid", pid, "-AppExe", process.execPath, "-TempDir", tempDir,
        ], { detached: true, stdio: "ignore" });
        proc.unref();
      } else {
        const appImagePath = process.env.APPIMAGE;
        const helper = path.join(tempDir, "update-linux.sh");
        fs.copyFileSync(path.join(__dirname, "update-linux.sh"), helper);
        const proc = spawn("/bin/bash", [helper, appImagePath, archivePath, pid, tempDir], {
          detached: true, stdio: "ignore",
        });
        proc.unref();
      }
      setUpdaterState("installing", { message: "Installing update. The launcher will restart shortly." });
      app.quit();
      return { ok: true, installing: true };
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
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
  const scale = Math.max(1, Math.min(9, Number(s.scale) || 1));
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

  let finished = false;
  const finish = (code, signal, error = null) => {
    if (finished) return;
    finished = true;
    if (child === proc) child = null;
    if (error) emit("log", { stream: "err", text: String(error) });
    emit("log", { stream: "meta", text: error ? `${label} failed to start` : `${label} exited (${signal || code})` });
    emit("task", { running: false, label, code, signal, error: error ? String(error) : undefined });
    if (onExit) onExit(code, signal);
  };
  proc.on("error", (err) => finish(null, null, err));
  proc.on("exit", (code, signal) => finish(code, signal));
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
function ensureLauncherLogo() {
  const destination = path.join(__dirname, "ui", "bomberman-online-logo.png");
  if (fs.existsSync(destination)) return;

  // In a source checkout, copy the root-level uploaded logo into the UI's local asset folder.
  // Packaged builds already contain this file because sync.js copies it before electron-builder.
  const candidates = [
    path.join(BUNDLED_ROOT, "9462-1643360380.png"),
    path.resolve(__dirname, "..", "..", "9462-1643360380.png"),
  ];
  const source = candidates.find((candidate) => fs.existsSync(candidate));
  if (!source) {
    console.warn("[Launcher] Bomberman Online logo asset was not found.");
    return;
  }
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  } catch (error) {
    console.warn(`[Launcher] Couldn't prepare the logo asset: ${error.message}`);
  }
}

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

  win.loadFile(path.join(__dirname, "ui", "index.html")).catch((err) => {
    console.error(`[Launcher] Couldn't load the UI: ${err.stack || err}`);
    if (SELFTEST) app.exit(1);
  });

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (SELFTEST) {
    selftestWatchdog = setTimeout(() => {
      console.error("SELFTEST_TIMEOUT: renderer did not finish and complete the test within 60 seconds");
      app.exit(1);
    }, 60_000);

    win.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        runSelftest().catch((err) => {
          // Last-resort guard: no self-test rejection should leave CI waiting forever.
          console.error(`SELFTEST_FATAL ${err && (err.stack || err)}`);
          app.exit(1);
        });
      }, 900);
    });
    win.webContents.once("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) {
        console.error(`SELFTEST_LOAD_FAILED ${code}: ${description} (${url})`);
        app.exit(1);
      }
    });
    win.webContents.once("render-process-gone", (_event, details) => {
      console.error(`SELFTEST_RENDERER_GONE ${JSON.stringify(details)}`);
      app.exit(1);
    });
  }
}

function withSelftestTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runSelftest() {
  const failures = [];
  const discArgTests = [
    {
      label: "--game value",
      argv: ["launcher", "--game", "/tmp/Bomberman Online.cue"],
      env: {},
      expected: "/tmp/Bomberman Online.cue",
    },
    {
      label: "--game=value",
      argv: ["launcher", "--game=/tmp/Bomberman Online.cue"],
      env: {},
      expected: "/tmp/Bomberman Online.cue",
    },
    {
      label: "--disc alias",
      argv: ["launcher", "--disc", "/tmp/Bomberman Online.chd"],
      env: {},
      expected: "/tmp/Bomberman Online.chd",
    },
    {
      label: "RecompLauncher environment fallback",
      argv: ["launcher"],
      env: { BMO_RECOMP_DISC: "/tmp/Bomberman Online.gdi" },
      expected: "/tmp/Bomberman Online.gdi",
    },
  ];
  for (const test of discArgTests) {
    const actual = suppliedRecompLauncherDisc(test.argv, test.env);
    if (actual !== test.expected) {
      failures.push(`RecompLauncher disc handoff failed for ${test.label}: expected ${test.expected}, got ${actual || "(empty)"}`);
    }
  }
  let report = null;
  let stats = null;
  let screenshot = null;

  try {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("launcher window was destroyed before self-test");
    }

    console.log("SELFTEST_PHASE renderer");
    report = await withSelftestTimeout(
      win.webContents.executeJavaScript("window.__selftest()"),
      20_000,
      "renderer self-test"
    );
    if (report && report.failures) failures.push(...report.failures);

    console.log("SELFTEST_PHASE screenshot");
    const image = await withSelftestTimeout(
      win.webContents.capturePage(),
      20_000,
      "Electron screenshot capture"
    );
    const size = image.getSize();
    if (!size.width || !size.height) {
      throw new Error(`screenshot has invalid dimensions: ${size.width}x${size.height}`);
    }
    const bmp = image.getBitmap(); // BGRA
    if (bmp.length < size.width * size.height * 4) {
      throw new Error(`screenshot bitmap is incomplete: ${bmp.length} bytes for ${size.width}x${size.height}`);
    }

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

    stats = {
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

    screenshot = path.join(__dirname, "selftest.png");
    try {
      fs.writeFileSync(screenshot, image.toPNG());
    } catch (err) {
      failures.push(`could not save screenshot: ${err}`);
    }
  } catch (err) {
    failures.push(`self-test execution failed: ${err && (err.stack || err)}`);
  } finally {
    if (selftestWatchdog) {
      clearTimeout(selftestWatchdog);
      selftestWatchdog = null;
    }
    console.log("SELFTEST_RESULT " + JSON.stringify({ report, stats, failures, screenshot }, null, 2));
    app.exit(failures.length ? 1 : 0);
  }
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
  // Migrate preset names saved by versions that mapped them to integer scales.
  const legacyPresetScales = { "720p": 1.5, "1080p": 2.25, "1440p": 3, "4k": 4.5, "8k": 9 };
  const savedResolution = String(s.resolution).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(legacyPresetScales, savedResolution)) {
    // Old builds wrote the preset name alongside its old integer scale. The named standard
    // resolution is authoritative now, including its 16:9 aspect requirement.
    s.resolution = savedResolution;
    s.scale = legacyPresetScales[savedResolution];
    s.aspect = "wide";
  } else if (!PRESETS[s.resolution]) {
    // Values saved by the brief relabel-only build stay available as custom scales.
    const intermediateScales = { "960p": 2, "1920p": 4, "2880p": 6, "3840p": 8 };
    if (Object.prototype.hasOwnProperty.call(intermediateScales, savedResolution)) {
      s.scale = Number.isFinite(stored.scale) ? stored.scale : intermediateScales[savedResolution];
      s.resolution = "custom";
    } else {
      const byLabel = Object.entries(PRESETS).find(
        ([, p]) => p.label.toLowerCase() === savedResolution
      );
      if (byLabel) s.resolution = byLabel[0];
      else if (typeof stored.scale === "number") {
        const byScale = Object.entries(PRESETS).find(([, p]) => p.scale === stored.scale);
        s.resolution = byScale ? byScale[0] : "custom";
      } else s.resolution = "native";
    }
  }
  if (!["bba", "modem", "pppoe"].includes(s.conn)) s.conn = "bba";
  // scale/aspect are authoritative; derive them once for older settings files.
  if (typeof s.scale !== "number" || !Number.isFinite(s.scale) || s.scale < 1 || s.scale > 9) {
    s.scale = (PRESETS[s.resolution] || PRESETS.native).scale;
  }
  if (!["native", "wide"].includes(s.aspect)) {
    s.aspect = (PRESETS[s.resolution] || PRESETS.native).aspect ? "wide" : "native";
  }
  return s;
}

function writeSettings(patch) {
  const merged = { ...readSettings(), ...patch };
  const requestedScale = Number(merged.scale);
  merged.scale = Number.isFinite(requestedScale) ? Math.max(1, Math.min(9, requestedScale)) : 1;
  merged.aspect = merged.aspect === "wide" ? "wide" : "native";
  // Match both scale and aspect so a 4:3 custom mode isn't called 720p.
  const preset = Object.entries(PRESETS).find(([, p]) =>
    p.scale === merged.scale && (p.aspect ? merged.aspect === "wide" : merged.aspect === "native")
  );
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
// RecompLauncher direct launch
// ---------------------------------------------------------------------------
// RecompLauncher sets RECOMPLAUNCHER=1 and supplies the player's disc with --game.
// BMO_RECOMP_DISC is the matching environment fallback in recomplauncher.json.
// Keep this path opt-in: ordinary standalone launches still open the existing UI.
function launchRecompLauncherGame() {
  if (process.env.RECOMPLAUNCHER !== "1") return false;

  const fail = (message) => {
    console.error(`[RecompLauncher] ${message}`);
    app.exit(1);
  };
  const suppliedDisc = suppliedRecompLauncherDisc(process.argv, process.env);
  if (!suppliedDisc || suppliedDisc.startsWith("--")) {
    fail("No disc image was supplied. Reinstall the game copy in RecompLauncher and try again.");
    return true;
  }

  const disc = path.resolve(suppliedDisc);
  try {
    if (!fs.statSync(disc).isFile()) {
      fail("The selected game copy is not a disc-image file.");
      return true;
    }
  } catch {
    fail("The selected disc image could not be found.");
    return true;
  }
  if (!fs.existsSync(EXE)) {
    fail("The packaged Bomberman Online game executable is missing.");
    return true;
  }

  const gameArgs = ["--config", CONFIG, "--disc", disc, "--window"];
  const options = { online: false, conn: "bba", dcnet: true, server: "", serverPort: "", fullscreen: process.env.RECOMPLAUNCHER_MODE === "bigpicture" };

  // These names are deliberately app-specific so Chromium/Electron doesn't consume them.
  for (let i = 1; i < process.argv.length; i++) {
    switch (process.argv[i]) {
      case "--bmo-scale": {
        const scale = Number(process.argv[i + 1]);
        if (Number.isFinite(scale) && scale >= 1 && scale <= 9) {
          if (scale !== 1) gameArgs.push("--scale", String(scale));
          i++;
        }
        break;
      }
      case "--bmo-widescreen":
        gameArgs.push("--render-aspect", (16 / 9).toFixed(4));
        break;
      case "--bmo-vsync":
        gameArgs.push("--sync-display");
        break;
      case "--bmo-fullscreen":
        options.fullscreen = true;
        break;
      case "--bmo-windowed":
        options.fullscreen = false;
        break;
      case "--bmo-fps":
        gameArgs.push("--fps");
        break;
      case "--bmo-no-audio":
        gameArgs.push("--no-audio");
        break;
      case "--bmo-online":
        options.online = true;
        break;
      case "--bmo-modem":
        options.conn = "modem";
        break;
    }
  }

  if (options.fullscreen) gameArgs.push("--fullscreen");
  if (fs.existsSync(BINDINGS_USER)) gameArgs.push("--bindings", BINDINGS_USER);
  try {
    fs.mkdirSync(path.dirname(VMU), { recursive: true });
    gameArgs.push("--vmu", VMU);
  } catch (error) {
    fail(`Couldn't prepare the VMU save path: ${error.message}`);
    return true;
  }

  try {
    child = spawn(EXE, gameArgs, {
      cwd: ROOT,
      env: toolEnv(onlineEnv(options)),
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(`[RecompLauncher] Couldn't start Bomberman Online: ${error.message}`);
      child = null;
      app.exit(1);
    });
    child.on("exit", (code) => {
      child = null;
      app.exit(Number.isInteger(code) ? code : 1);
    });
    process.once("SIGTERM", () => {
      if (child) stopChild();
    });
    process.once("SIGINT", () => {
      if (child) stopChild();
    });
  } catch (error) {
    child = null;
    fail(`Couldn't start Bomberman Online: ${error.message}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  ensureLauncherLogo();
  prepareWorkspace();
  if (launchRecompLauncherGame()) return;
  if (!app.isPackaged) setUpdaterState("development", { message: "Updates are available in packaged releases." });
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
