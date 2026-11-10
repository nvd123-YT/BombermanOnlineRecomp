/* Bomberman Online launcher — renderer process (no framework, no build step). */

const $ = (id) => document.getElementById(id);

let snapshot = null;
let S = null;                 // settings (authoritative copy in the UI)
let saveTimer = null;
let running = false;
let toastTimer = null;
let netBusy = false;
let updateStatus = { state: "idle" };

const MAX_LOG_LINES = 2500;
let logLines = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function basename(p) {
  if (!p) return "";
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function dirname(p) {
  if (!p) return "";
  const s = String(p);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i > 0 ? s.slice(0, i) : "";
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function toast(text, kind = "") {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast " + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
}

function setStatus(text, kind = "") {
  const el = $("statusLeft");
  el.textContent = text;
  el.className = kind;
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------
function log(text, stream = "out") {
  const el = $("log");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  const line = document.createElement("span");
  line.className = stream;
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  line.textContent = `[${stamp}] ${text}\n`;
  el.appendChild(line);
  logLines++;
  while (logLines > MAX_LOG_LINES && el.firstChild) {
    el.removeChild(el.firstChild);
    logLines--;
  }
  if ($("autoScroll").checked && atBottom) el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function save(immediate = false) {
  clearTimeout(saveTimer);
  const commit = async () => {
    try {
      S = await window.api.saveSettings(S);
      refreshDerived();
    } catch (err) {
      toast(`Could not save settings: ${err}`, "err");
    }
  };
  if (immediate) commit();
  else saveTimer = setTimeout(commit, 220);
}

function presetForScale(scale) {
  const found = Object.entries(snapshot.presets).find(([, p]) => p.scale === scale);
  return found ? found[0] : null;
}

function refreshDerived() {
  // Render output readout.
  const scale = clamp(Number(S.scale) || 1, 1, 8);
  const width = 640 * scale;
  const height = S.aspect === "wide" ? Math.round(width / (16 / 9)) : 480 * scale;
  $("renderOut").textContent = `${width} × ${height}`;
  $("scaleVal").textContent = `${scale}×`;
  const pct = ((scale - 1) / 7) * 100;
  $("scaleRange").style.setProperty("--fill", `${pct}%`);

  // Preset pills.
  const key = presetForScale(scale);
  for (const btn of $("resPills").querySelectorAll("button")) {
    const p = snapshot.presets[btn.dataset.preset];
    const matchesAspect =
      (p.aspect ? S.aspect === "wide" : S.aspect === "native");
    btn.classList.toggle("active", btn.dataset.preset === key && matchesAspect);
  }

  // Online field state.
  const on = !!S.online;
  for (const id of ["connSel", "serverInput", "serverPort"]) {
    $(id).disabled = !on;
  }
  $("testNetBtn").disabled = !on || netBusy;

  // Disc line.
  updateDiscDisplay();
  updateLaunchState();
}

// ---------------------------------------------------------------------------
// Disc
// ---------------------------------------------------------------------------
function updateDiscDisplay() {
  const info = snapshot.discInfo;
  const path = S.disc;
  if (!path) {
    $("discName").textContent = "Choose your Bomberman Online disc image";
    $("discMeta").textContent = "No disc selected";
    $("discStatus").textContent = "Waiting for a disc image.";
    $("discStatus").className = "status-line";
    return;
  }
  $("discName").textContent = basename(path);
  if (info && info.exists) {
    const mb = (info.size / (1024 * 1024)).toFixed(1);
    $("discMeta").textContent = `${dirname(path)}  ·  ${mb} MiB`;
    $("discStatus").textContent = "Disc image found.";
    $("discStatus").className = "status-line ok";
  } else {
    $("discMeta").textContent = dirname(path);
    $("discStatus").textContent = "File not found — choose the disc again.";
    $("discStatus").className = "status-line err";
  }
}

async function chooseDisc() {
  const path = await window.api.pickDisc();
  if (!path) return;
  S.disc = path;
  save(true);
  snapshot.discInfo = null;
  log(`disc set: ${path}`, "meta");
  refreshDerived();
  // Ask main for fresh info on next state read.
  snapshot = await window.api.getState();
  refreshDerived();
}

async function detectDisc() {
  const path = await window.api.detectDisc();
  if (!path) {
    toast("No .chd/.gdi/.cue/.cdi image found. Use Browse…", "err");
    return;
  }
  S.disc = path;
  save(true);
  log(`auto-detected disc: ${path}`, "meta");
  snapshot = await window.api.getState();
  refreshDerived();
}

// ---------------------------------------------------------------------------
// Launch state
// ---------------------------------------------------------------------------
function updateLaunchState() {
  const built = snapshot.built;
  const renderer = snapshot.renderer;
  const hasDisc = !!S.disc;
  const canPlay = built && renderer && hasDisc && !running;
  $("playBtn").disabled = !canPlay;

  if (!built) $("playSub").textContent = "Build the port first";
  else if (!renderer) $("playSub").textContent = "Headless build — rebuild for a window";
  else if (!hasDisc) $("playSub").textContent = "Choose a disc image";
  else if (running) $("playSub").textContent = "A task is running…";
  else $("playSub").textContent = "Launch the game window";

  $("buildBtn").disabled = running;
  $("headlessBtn").disabled = running || !built;
  $("stopBtn").disabled = !running;

  const buildChip = $("chipBuild");
  buildChip.textContent = built ? "Build: ready" : "Build: missing";
  buildChip.className = "chip " + (built ? "good" : "bad");

  const renderChip = $("chipRenderer");
  renderChip.textContent = renderer ? "Renderer: on" : "Renderer: off";
  renderChip.className = "chip " + (renderer ? "good" : "warn");
}

function setRunning(value, label = "") {
  running = value;
  updateLaunchState();
  if (value) setStatus(`${label} running…`, "warn");
  else setStatus("Ready");
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function play() {
  if (!S.disc) {
    toast("Choose a disc image first.", "err");
    return;
  }
  const res = await window.api.play(S);
  if (!res.ok) {
    toast(res.error || "Could not start the game.", "err");
    return;
  }
  // Progress comes from the task events: setup -> build -> game, each with its own status.
}

async function headless() {
  const res = await window.api.headless(S);
  if (!res.ok) toast(res.error || "Could not start the report.", "err");
}

async function build() {
  const res = await window.api.build(S);
  if (!res.ok) toast(res.error || "Could not start the build.", "err");
}

async function stop() {
  const res = await window.api.stop();
  if (!res.ok) toast("Nothing is running.", "err");
}

async function testConnection() {
  if (netBusy) return;
  const host = (S.server || "dcnet.flyca.st").trim();
  const port = (S.serverPort || "7655").trim();
  netBusy = true;
  $("testNetBtn").disabled = true;
  $("netStatus").textContent = "Testing…";
  $("netStatus").className = "status-line";
  const res = await window.api.testNet(host, port);
  netBusy = false;
  $("testNetBtn").disabled = false;
  if (res.ok) {
    $("netStatus").textContent = `Reachable — ${res.ms} ms`;
    $("netStatus").className = "status-line ok";
  } else {
    $("netStatus").textContent = `Unreachable — ${res.error || "error"}`;
    $("netStatus").className = "status-line err";
  }
}

// ---------------------------------------------------------------------------
// Bindings editor
// ---------------------------------------------------------------------------
let bindLines = [];
let capturing = null; // { key, device, rowEl, valueEl }
let bindSource = "";

function parseBindings(text) {
  const lines = [];
  let section = "general";
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) lines.push({ raw, type: "blank", section });
    else if (trimmed.startsWith("#")) lines.push({ raw, type: "comment", section });
    else if (/^\[.+\]$/.test(trimmed)) {
      section = trimmed.slice(1, -1).trim();
      lines.push({ raw, type: "section", section });
    } else {
      const m = trimmed.match(/^([^=]+?)\s*=\s*(.*)$/);
      if (m) lines.push({ raw, type: "kv", section, key: m[1].trim(), value: m[2].trim() });
      else lines.push({ raw, type: "comment", section });
    }
  }
  return lines;
}

function renderBindings() {
  const host = $("bindRows");
  host.innerHTML = "";
  let current = null;
  let sectionEl = null;
  for (const line of bindLines) {
    if (line.type !== "kv") continue;
    if (line.section !== current) {
      current = line.section;
      sectionEl = document.createElement("div");
      sectionEl.className = "bind-section";
      sectionEl.textContent = current === "general" ? "General" : current;
      host.appendChild(sectionEl);
    }
    const row = document.createElement("div");
    row.className = "bind-row";

    const name = document.createElement("span");
    name.className = "bind-name";
    name.textContent = line.key;

    const value = document.createElement("span");
    value.className = "bind-value";
    value.textContent = line.value;

    const btn = document.createElement("button");
    btn.className = "btn btn-tiny";
    btn.textContent = "Bind";
    btn.onclick = () => startCapture(line, row, value, btn);

    row.append(name, value, btn);
    host.appendChild(row);
  }
}

function startCapture(line, row, valueEl, btn) {
  if (capturing) stopCapture();
  capturing = { line, rowEl: row, valueEl, btn };
  row.classList.add("capturing");
  valueEl.textContent = "Press a key or button…";
  btn.textContent = "Cancel";
  btn.onclick = (e) => {
    e.stopPropagation();
    stopCapture();
  };
}

function stopCapture() {
  if (!capturing) return;
  const line = capturing.line;
  const row = capturing.rowEl;
  const valueEl = capturing.valueEl;
  const btn = capturing.btn;
  row.classList.remove("capturing");
  valueEl.textContent = line.value;
  btn.textContent = "Bind";
  btn.onclick = () => startCapture(line, row, valueEl, btn);
  capturing = null;
}

function applyCapture(value, device) {
  if (!capturing) return;
  // Keyboard bindings only make sense in the keyboard section, and pad
  // bindings in the gamepad section, but allow either to be written where the
  // user asked so unusual setups still work.
  capturing.line.value = value;
  capturing.valueEl.textContent = value;
  log(`bound ${capturing.line.key} = ${value} (${device})`, "meta");
  stopCapture();
}

function sdlKey(event) {
  const code = event.code || "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return "KP " + code.slice(6);
  const map = {
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Enter: "Return", NumpadEnter: "KP Enter", Space: "Space", Escape: "Escape",
    Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    ShiftLeft: "Left Shift", ShiftRight: "Right Shift",
    ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl",
    AltLeft: "Left Alt", AltRight: "Right Alt",
    Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[",
    BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
    Comma: ",", Period: ".", Slash: "/", CapsLock: "CapsLock",
  };
  if (map[code]) return map[code];
  if (/^F\d{1,2}$/.test(code)) return code;
  return event.key && event.key.length === 1 ? event.key.toLowerCase() : code;
}

const PAD_BUTTONS = [
  "a", "b", "x", "y", "leftshoulder", "rightshoulder", "lefttrigger",
  "righttrigger", "back", "start", "leftstick", "rightstick",
  "dpup", "dpdown", "dpleft", "dpright", "guide",
];
const PAD_AXES = ["leftx", "lefty", "rightx", "righty"];

function padBindingForButton(index) {
  if (index === 6) return "axis:lefttrigger+";
  if (index === 7) return "axis:righttrigger+";
  const name = PAD_BUTTONS[index];
  return name ? `button:${name}` : `button:${index}`;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
async function openRemap() {
  const res = await window.api.readBindings();
  bindSource = res.text;
  bindLines = parseBindings(bindSource);
  renderBindings();
  $("modal").hidden = false;
  $("modalClose").focus();
}

function closeRemap() {
  stopCapture();
  $("modal").hidden = true;
}

async function resetBindings() {
  const res = await window.api.readBindingsDefaults();
  if (!res || !res.text) {
    toast(res && res.error ? res.error : "Default bindings are missing.", "err");
    return;
  }
  bindLines = parseBindings(res.text);
  renderBindings();
  toast("Defaults loaded — press Save to keep them.", "ok");
}

async function saveBindings() {
  const text = bindLines.map((l) => l.raw).join("\n");
  const res = await window.api.writeBindings(text);
  if (!res.ok) {
    toast(res.error || "Could not save bindings.", "err");
    return;
  }
  log(`bindings saved: ${res.path}`, "meta");
  toast("Bindings saved.", "ok");
  closeRemap();
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
let pads = [];
let prevPad = new Map();
let navFocus = 0;
let stickCooldown = 0;

function padLabel(pad) {
  return pad.id.replace(/\s*\(.*?\)\s*$/, "") || "Controller";
}

function navScope() {
  return $("modal").hidden ? document : $("modal");
}

function navItems() {
  return [...navScope().querySelectorAll("[data-nav]")].filter(
    (el) => !el.disabled && el.offsetParent !== null
  );
}

function moveNav(delta) {
  const items = navItems();
  if (!items.length) return;
  navFocus = (navFocus + delta + items.length) % items.length;
  for (const el of items) el.classList.remove("nav-focus");
  const el = items[navFocus];
  el.classList.add("nav-focus");
  el.focus({ preventScroll: false });
}

function activateNav() {
  const items = navItems();
  if (!items.length) return;
  const el = items[clamp(navFocus, 0, items.length - 1)];
  el.click();
}

function updatePadChip() {
  const pad = pads[0];
  const chip = $("padChip");
  const text = $("padChipText");
  if (pad) {
    text.textContent = padLabel(pad);
    chip.className = "chip good";
    $("padName").textContent = padLabel(pad);
  } else {
    text.textContent = "No controller";
    chip.className = "chip";
    $("padName").textContent = "Keyboard";
  }
}

function renderPadTest(pad) {
  const btnHost = $("padButtons");
  const axisHost = $("padAxes");
  if (!pad) {
    btnHost.innerHTML = '<span class="status-line">Connect a controller to test it.</span>';
    axisHost.innerHTML = "";
    return;
  }
  if (btnHost.children.length !== pad.buttons.length) {
    btnHost.innerHTML = "";
    pad.buttons.forEach((_, i) => {
      const el = document.createElement("span");
      el.className = "pad-btn";
      el.textContent = PAD_BUTTONS[i] || String(i);
      btnHost.appendChild(el);
    });
    axisHost.innerHTML = "";
    pad.axes.forEach((_, i) => {
      const row = document.createElement("div");
      row.className = "axis-row";
      row.innerHTML = `<span class="axis-name">${PAD_AXES[i] || i}</span>
        <span class="axis-bar"><span class="axis-fill"></span></span>`;
      axisHost.appendChild(row);
    });
  }
  [...btnHost.children].forEach((el, i) => {
    el.classList.toggle("on", !!(pad.buttons[i] && pad.buttons[i].pressed));
  });
  [...axisHost.querySelectorAll(".axis-fill")].forEach((el, i) => {
    const v = pad.axes[i] || 0;
    const pct = Math.abs(v) * 50;
    el.style.width = `${pct}%`;
    el.style.left = v >= 0 ? "50%" : `${50 - pct}%`;
  });
}

function pollPads(now) {
  pads = [...navigator.getGamepads()].filter(Boolean);
  updatePadChip();
  if (!$("padTest").hidden) renderPadTest(pads[0]);

  const pad = pads[0];
  if (!pad) {
    prevPad.clear();
    return;
  }

  // Edge detection so holding a direction moves one step at a time.
  const pressed = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
  const prev = prevPad.get(pad.index) || [];
  const edge = (i) => pressed(i) && !prev[i];

  const up = edge(12) || (pad.axes[1] < -0.65 && now > stickCooldown);
  const down = edge(13) || (pad.axes[1] > 0.65 && now > stickCooldown);
  const left = edge(14) || (pad.axes[0] < -0.65 && now > stickCooldown);
  const right = edge(15) || (pad.axes[0] > 0.65 && now > stickCooldown);
  if (up || down || left || right) stickCooldown = now + 220;

  if (up || left) moveNav(-1);
  if (down || right) moveNav(1);
  if (edge(0)) activateNav();          // A
  if (edge(1) && !$("modal").hidden) closeRemap(); // B

  // Binding capture from the pad.
  if (capturing) {
    for (let i = 0; i < pad.buttons.length; i++) {
      if (edge(i)) {
        applyCapture(padBindingForButton(i), "gamepad");
        break;
      }
    }
    for (let i = 0; i < pad.axes.length; i++) {
      const v = pad.axes[i];
      if (Math.abs(v) > 0.7) {
        const name = PAD_AXES[i] || `axis${i}`;
        applyCapture(`axis:${name}${v > 0 ? "+" : "-"}`, "gamepad");
        break;
      }
    }
  }

  prevPad.set(pad.index, pad.buttons.map((b) => b.pressed));
}

function renderUpdateState(state) {
  if (!state) return;
  updateStatus = state;
  const btn = $("updateBtn");
  const labels = {
    idle: "Check for updates",
    development: "Releases",
    checking: "Checking…",
    available: `Download ${state.availableVersion || "update"}`,
    downloading: state.percent == null ? "Downloading…" : `Downloading ${state.percent}%`,
    installing: "Installing…",
    current: "Up to date",
    manual: "Download update",
    error: "Retry update",
  };
  btn.textContent = labels[state.state] || "Check for updates";
  btn.disabled = ["checking", "downloading", "installing"].includes(state.state);
  btn.title = state.message || "";
  btn.classList.toggle("update-ready", state.state === "available");
}

async function updateAction() {
  const btn = $("updateBtn");
  btn.disabled = true;
  try {
    const result = await window.api.updateAction();
    if (result && result.error) toast(result.error, "err");
    else if (result && result.manual) toast("Open Releases to download and install the latest build.", "info");
  } catch (error) {
    toast(`Update check failed: ${error}`, "err");
  } finally {
    // Keep the button disabled only while the updater is actively working.
    if (btn.isConnected) btn.disabled = ["checking", "downloading", "installing"].includes(updateStatus.state);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function bindEvents() {
  $("discDrop").addEventListener("click", chooseDisc);
  $("detectBtn").addEventListener("click", detectDisc);
  $("playBtn").addEventListener("click", play);
  $("headlessBtn").addEventListener("click", headless);
  $("buildBtn").addEventListener("click", build);
  $("stopBtn").addEventListener("click", stop);
  $("testNetBtn").addEventListener("click", testConnection);
  $("updateBtn").addEventListener("click", updateAction);

  $("resPills").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-preset]");
    if (!btn) return;
    const preset = snapshot.presets[btn.dataset.preset];
    S.scale = preset.scale;
    S.aspect = preset.aspect ? "wide" : "native";
    S.resolution = btn.dataset.preset;
    $("scaleRange").value = String(S.scale);
    $("aspectSel").value = S.aspect;
    refreshDerived();
    save();
  });

  $("scaleRange").addEventListener("input", () => {
    S.scale = clamp(Number($("scaleRange").value) || 1, 1, 8);
    S.resolution = presetForScale(S.scale) || "native";
    refreshDerived();
    save();
  });

  $("aspectSel").addEventListener("change", () => {
    S.aspect = $("aspectSel").value;
    refreshDerived();
    save();
  });

  for (const [id, key] of [
    ["vsync", "vsync"], ["fullscreen", "fullscreen"], ["fps", "fps"],
    ["audio", "audio"], ["online", "online"],
  ]) {
    $(id).addEventListener("change", () => {
      S[key] = $(id).checked;
      refreshDerived();
      save();
    });
  }

  for (const [id, key] of [
    ["connSel", "conn"], ["serverInput", "server"], ["serverPort", "serverPort"],
  ]) {
    $(id).addEventListener("input", () => {
      S[key] = $(id).value;
      save();
    });
  }

  $("remapBtn").addEventListener("click", openRemap);
  $("modalClose").addEventListener("click", closeRemap);
  $("bindCancel").addEventListener("click", closeRemap);
  $("bindSave").addEventListener("click", saveBindings);
  $("bindReset").addEventListener("click", resetBindings);
  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal")) closeRemap();
  });

  $("padTestBtn").addEventListener("click", () => {
    const panel = $("padTest");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderPadTest(pads[0]);
  });

  $("clearLog").addEventListener("click", () => {
    $("log").textContent = "";
    logLines = 0;
  });
  $("logToggle").addEventListener("click", () => {
    const panel = $("logpanel");
    panel.classList.toggle("collapsed");
    $("logToggle").setAttribute(
      "aria-expanded", String(!panel.classList.contains("collapsed"))
    );
  });
  $("copyLog").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("log").textContent);
      toast("Output copied.", "ok");
    } catch {
      toast("Clipboard unavailable.", "err");
    }
  });

  $("winctl").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-win]");
    if (!btn) return;
    const action = btn.dataset.win;
    if (action === "minimize") window.api.minimize();
    else if (action === "maximize") window.api.maximize();
    else window.api.close();
  });

  document.addEventListener("keydown", (e) => {
    if (capturing) {
      if (e.key === "Escape") {
        stopCapture();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      applyCapture(`key:${sdlKey(e)}`, "keyboard");
      return;
    }
    if (e.key === "Escape" && !$("modal").hidden) closeRemap();
    if (e.key === "Enter" && !$("modal").hidden) return;
  });

  window.api.onLog(({ stream, text }) => log(text, stream));
  window.api.onTask(({ running: isRunning, label }) => setRunning(isRunning, label));
  window.api.onToast(({ kind, text }) => toast(text, kind));
  window.api.onUpdateStatus((state) => renderUpdateState(state));
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  snapshot = await window.api.getState();
  S = { ...snapshot.settings };
  document.body.classList.toggle("mac", snapshot.platform === "darwin");

  // Seed controls from settings.
  $("scaleRange").value = String(clamp(Number(S.scale) || 1, 1, 8));
  $("aspectSel").value = S.aspect === "wide" ? "wide" : "native";
  $("vsync").checked = !!S.vsync;
  $("fullscreen").checked = !!S.fullscreen;
  $("fps").checked = !!S.fps;
  $("audio").checked = !!S.audio;
  $("online").checked = !!S.online;
  $("connSel").value = S.conn || "bba";
  $("serverInput").value = S.server || "";
  $("serverPort").value = S.serverPort || "7655";
  $("statusRight").textContent = `launcher ${snapshot.version}`;
  renderUpdateState(snapshot.updateState || { state: "idle" });

  bindEvents();
  refreshDerived();
  updateLaunchState();

  $("netNote").textContent =
    "DCNet tunnels the Dreamcast modem/BBA to a real access point. " +
    "The launcher stores these settings and tests reachability; the engine-side " +
    "network device is wired separately.";

  log("Launcher ready.", "meta");
  log(`root: ${snapshot.paths.root}`, "meta");
  log(`disc: ${S.disc || "(none)"}`, "meta");

  // Controller polling loop.
  let last = performance.now();
  const loop = (now) => {
    pollPads(now);
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  window.addEventListener("gamepadconnected", (e) => {
    log(`controller connected: ${e.gamepad.id}`, "meta");
    toast(`Controller connected: ${padLabel(e.gamepad)}`, "ok");
  });
  window.addEventListener("gamepaddisconnected", (e) => {
    log(`controller disconnected: ${e.gamepad.id}`, "meta");
  });
}

// ---------------------------------------------------------------------------
// Self-test (used by `npm run selftest`)
// ---------------------------------------------------------------------------
window.__selftest = () => {
  const failures = [];
  const rects = {};
  const ids = [
    "titlebar", "discDrop", "discName", "detectBtn", "playBtn", "headlessBtn",
    "buildBtn", "stopBtn", "resPills", "scaleRange", "aspectSel", "vsync",
    "fullscreen", "fps", "audio", "online", "connSel", "serverInput",
    "testNetBtn", "remapBtn", "updateBtn", "logpanel", "log", "statusLeft", "padChip",
  ];
  // These live in fixed regions and must be on screen without scrolling.
  const fixedIds = new Set([
    "titlebar", "discDrop", "playBtn", "logpanel", "log", "statusLeft", "padChip", "updateBtn",
  ]);
  for (const id of ids) {
    const el = $(id);
    if (!el) {
      failures.push(`missing #${id}`);
      continue;
    }
    const r = el.getBoundingClientRect();
    rects[id] = {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
    };
    if (r.width < 4 || r.height < 4) failures.push(`#${id} has zero size`);
    if (fixedIds.has(id)) {
      if (r.top < -2 || r.left < -2) failures.push(`#${id} is off-screen`);
      if (r.bottom > window.innerHeight + 2) failures.push(`#${id} is below the viewport`);
    }
  }

  const labels = [...document.querySelectorAll("label")]
    .map((l) => l.textContent.trim())
    .filter(Boolean);
  if (labels.length < 10) failures.push(`too few labelled controls (${labels.length})`);

  const body = getComputedStyle(document.body);
  const playText = $("playBtn").textContent.replace(/\s+/g, " ").trim();
  if (!/Play/.test(playText)) failures.push("Play button has no visible label");
  if (!/Browse/.test($("discDrop").textContent)) failures.push("disc card has no Browse label");
  const visibleText = document.body.innerText.toLowerCase();
  for (const phrase of ["resolution preset", "render scale", "aspect ratio",
                        "connection type", "dcnet server", "remap controls"]) {
    if (!visibleText.includes(phrase)) failures.push(`missing label text: ${phrase}`);
  }

  const logRect = rects.log;
  if (logRect && logRect.y < window.innerHeight * 0.5) {
    failures.push("output log is not pinned to the lower half of the window");
  }
  if (logRect && logRect.y + logRect.h > window.innerHeight + 2) {
    failures.push("output log extends below the window");
  }

  return {
    failures,
    rects,
    labels,
    playText,
    bodyBg: body.backgroundColor,
    bodyColor: body.color,
    fontFamily: body.fontFamily,
    size: [window.innerWidth, window.innerHeight],
    settings: S,
    built: snapshot && snapshot.built,
    renderer: snapshot && snapshot.renderer,
    platform: snapshot && snapshot.platform,
  };
};

init().catch((err) => {
  console.error(err);
  log(`startup failed: ${err}`, "err");
  toast(`Startup failed: ${err}`, "err");
});
