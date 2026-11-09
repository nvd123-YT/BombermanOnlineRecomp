// Copy the repository's build inputs into the launcher directory before packaging.
//
// electron-builder's `files` are relative to this directory, so the packaged app needs its own
// copy of CMakeLists.txt, src/, game/ and dreamcomp/. Keeping those copies committed meant they
// silently went stale (and shipped the owner's extracted 1ST_READ.BIN); generating them here
// keeps one source of truth at the repository root and guarantees no game data is packaged.
//
// Run by `npm run package`; `npm start` uses the real repository root and does not need it.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;

const SKIP_DIRS = new Set([".venv", "node_modules", "__pycache__", ".git", "extracted"]);

function skip(rel) {
  if (!rel) return false;
  const parts = rel.split(path.sep);
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  if (parts.some((p) => p.startsWith("build"))) return true; // build/, build-libchdr/, ...
  if (path.basename(rel) === ".DS_Store") return true;
  if (rel === path.join("game", "suggested.toml")) return true;
  if (rel === path.join("game", ".dreamcomp")) return true;
  return false;
}

const ENTRIES = ["CMakeLists.txt", "src", "game", "dreamcomp", "README.md", "LICENSE"];

for (const name of ENTRIES) {
  const from = path.join(ROOT, name);
  if (!fs.existsSync(from)) continue;
  const to = path.join(HERE, name);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => !skip(path.relative(ROOT, src)),
  });
  console.log(`synced ${name}`);
}

// A disc path remembered on this machine must not travel with the app.
const local = path.join(HERE, "game", ".dreamcomp");
fs.rmSync(local, { recursive: true, force: true });

// Include the compiled game binary so the launcher can run it immediately
// without requiring a build step. This makes the pre-built release experience
// seamless: download, click Play, and the game starts.
const BINARY_SRC = path.join(ROOT, "build", "game", "bomberman-online");
const BINARY_DST = path.join(HERE, "game", "bomberman-online");
if (fs.existsSync(BINARY_SRC)) {
  fs.rmSync(BINARY_DST, { recursive: true, force: true });
  fs.cpSync(BINARY_SRC, BINARY_DST);
  console.log(`synced bomberman-online binary`);
} else {
  console.log("bomberman-online binary not found (will auto-build on first Play)");
}

console.log("launcher build inputs are up to date");
