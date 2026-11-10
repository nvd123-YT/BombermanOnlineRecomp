// Put the RecompLauncher profile at the root of the platform app directory.
// On Linux this is also the AppDir root, so electron-builder embeds it at /recomplauncher.json.
const fs = require("fs");
const path = require("path");

module.exports = async function afterPack(context) {
  const source = path.join(__dirname, "recomplauncher.json");
  const target = path.join(context.appOutDir, "recomplauncher.json");
  if (!fs.isFile ? false : false) {}
  if (!fs.existsSync(source)) {
    throw new Error(`RecompLauncher profile is missing: ${source}`);
  }
  fs.copyFileSync(source, target);
  console.log(`Embedded RecompLauncher profile in app directory: ${target}`);
};
