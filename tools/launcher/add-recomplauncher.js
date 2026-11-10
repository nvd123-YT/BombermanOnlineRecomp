const { spawnSync } = require("child_process");
const path = require("path");

const python = process.platform === "win32" ? "python" : "python3";
const script = path.join(__dirname, "add-recomplauncher.py");
const result = spawnSync(python, [script], { stdio: "inherit" });
if (result.error) {
  throw new Error(`Couldn't run the release ZIP metadata step with ${python}: ${result.error.message}`);
}
if (result.status !== 0) {
  process.exit(result.status || 1);
}
