import { createServer } from "node:http";
import dgram from "node:dgram";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const moduleDir = new URL(".", import.meta.url);
const distUrl = new URL("../dist/chargen.js", moduleDir);
const srcUrl = new URL("../src/chargen.js", moduleDir);
const chargenModuleUrl = existsSync(fileURLToPath(distUrl)) ? distUrl : srcUrl;
const { getChargenGlyphs } = await import(chargenModuleUrl.href);

function parseNumeric(value, defaultRadix = 16) {
  if (!value) {
    return 0;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("$")) {
    return Number.parseInt(trimmed.slice(1), 16);
  }
  if (trimmed.startsWith("0x")) {
    return Number.parseInt(trimmed.slice(2), 16);
  }
  if (trimmed.startsWith("%")) {
    return Number.parseInt(trimmed.slice(1), 2);
  }
  return Number.parseInt(trimmed, defaultRadix);
}

function normaliseHexString(input) {
  if (!input) {
    return "";
  }
  return input.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

function createDefaultConfigs() {
  return {
    Audio: {
      Volume: "6",
      Balance: "center",
    },
    Video: {
      Mode: "PAL",
    },
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return Buffer.alloc(0);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  try {
    const body = await readRequestBody(req);
    if (body.length === 0) {
      return {};
    }
    return JSON.parse(body.toString("utf8"));
  } catch {
    return {};
  }
}

function sendJson(res, payload = {}, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  const body = { ...payload };
  if (!Object.prototype.hasOwnProperty.call(body, "errors")) {
    body.errors = [];
  }
  res.end(JSON.stringify(body));
}

function createInitialState() {
  return {
    networkPassword: null,
    forcedErrors: null,
    forcedErrorsUrlMatch: null,
    hangOnMachineInputProbe: false,
    lastPrg: null,
    lastLoadedPrg: null,
    loadCount: 0,
    runCount: 0,
    resets: 0,
    reboots: 0,
  poweroffs: 0,
    memory: new Uint8Array(0x10000),
    heartbeat: null,
    lastWrite: null,
    writeLog: [],
    lastRequest: null,
    drives: {},
    lastDriveOperation: null,
    createdImages: [],
    lastFileInfo: null,
    sidplayCount: 0,
    lastSidplay: null,
    sidAttachmentCount: 0,
    lastSidAttachment: null,
    modplayCount: 0,
    lastModplay: null,
    paused: false,
  lastPause: null,
  lastResume: null,
  lastPoweroff: null,
    debugreg: "00",
    configs: createDefaultConfigs(),
    flashSnapshot: null,
    lastConfigAction: null,
  menuToggleCount: 0,
  lastMenuTarget: null,
    menuScreen: Buffer.from([0x41, 0x01, 0x42, 0x02]),
    inputState: { keyboard: { inputs: [] }, joysticks: [{ port: 1, inputs: [] }, { port: 2, inputs: [] }] },
    streams: {
      video: { active: false, target: null, packetsSent: 0 },
      audio: { active: false, target: null, packetsSent: 0 },
      debug: { active: false, target: null, packetsSent: 0 },
    },
    lastStreamAction: null,
    streamActionLog: [],
  };
}

function createStreamRuntime() {
  return {
    video: { interval: null, socket: null, sequence: 0, frameNumber: 0, sampleIndex: 0 },
    audio: { interval: null, socket: null, sequence: 0, frameNumber: 0, sampleIndex: 0 },
    debug: { interval: null, socket: null, sequence: 0, frameNumber: 0, sampleIndex: 0 },
  };
}

const SCREEN_CODE_LOOKUP = (() => {
  const map = new Map();
  for (const glyph of getChargenGlyphs()) {
    if (!glyph || typeof glyph.screenCode !== "number") {
      continue;
    }
    const code = glyph.screenCode & 0xff;
    if (glyph.basic && glyph.basic.length === 1 && !map.has(glyph.basic)) {
      map.set(glyph.basic, code);
    }
    if (!map.has(String.fromCharCode(glyph.petsciiCode & 0xff))) {
      map.set(String.fromCharCode(glyph.petsciiCode & 0xff), code);
    }
  }
  if (!map.has(" ")) {
    map.set(" ", 0x20);
  }
  return map;
})();

function toScreenCode(char) {
  return SCREEN_CODE_LOOKUP.get(char) ?? SCREEN_CODE_LOOKUP.get(" ") ?? 0x20;
}

const KERNAL_KEYBOARD_NDX_ADDRESS = 0x00c6;
const KERNAL_KEYBOARD_BUFFER_ADDRESS = 0x0277;

const SYS_COMMAND_PATTERN = /SYS\s*\d+/i;
const HEARTBEAT_ADDRESS = 0x0400; // Screen-RAM byte the ASM liveness poller watches.
const HEARTBEAT_GRANULARITY_MS = 10; // Well below the poll interval so consecutive liveness reads always differ.
const HEARTBEAT_DURATION_MS = 1000; // How long a SYS-triggered program keeps "running".

/**
 * Nothing in this mock runs 6502 code to drain the KERNAL keyboard buffer
 * itself, so a client polling NDX ($00C6) waiting for it to return to zero
 * would otherwise hang forever. Simulate the KERNAL's IRQ-driven drain with
 * a short delay so injectKeyboardQueue's poll loop behaves realistically.
 *
 * When the queued text looks like a typed `SYSnnnnn` command (the trigger
 * upload_run_asm uses to enter an assembled program), also record a
 * time-computed "alive" window (consumed by readMemoryWithHeartbeat). This
 * mock never executes 6502 code, so a liveness poller watching screen RAM
 * would otherwise see no progression. Recording a descriptor rather than
 * mutating memory from a background timer is deliberate: nothing advances
 * asynchronously, so an unrelated later test that merely shares this server
 * instance can never observe a stray screen-RAM mutation.
 */
function simulateKeyboardDrain(state, address) {
  if (address !== KERNAL_KEYBOARD_NDX_ADDRESS) return;
  const pending = state.memory[KERNAL_KEYBOARD_NDX_ADDRESS] ?? 0;
  const queued = pending > 0
    ? Uint8Array.from(state.memory.subarray(KERNAL_KEYBOARD_BUFFER_ADDRESS, KERNAL_KEYBOARD_BUFFER_ADDRESS + pending))
    : null;
  setTimeout(() => {
    state.memory[KERNAL_KEYBOARD_NDX_ADDRESS] = 0;
    if (!queued) return;
    const text = Buffer.from(queued).toString("ascii");
    if (!SYS_COMMAND_PATTERN.test(text)) return;
    state.heartbeat = {
      address: HEARTBEAT_ADDRESS,
      startedAt: Date.now(),
      durationMs: HEARTBEAT_DURATION_MS,
      baseValue: state.memory[HEARTBEAT_ADDRESS] ?? 0,
    };
  }, 5);
}

/**
 * Serve a screen-RAM read, overlaying a synthetic, monotonically advancing
 * byte at the heartbeat address while a SYS-triggered "alive" window is open.
 * The overlay is a pure function of elapsed time applied only to the returned
 * copy, so it never mutates stored memory and never advances on its own.
 */
function readMemoryWithHeartbeat(state, address, length) {
  const bytes = state.memory.slice(address, address + length);
  const heartbeat = state.heartbeat;
  if (!heartbeat) return bytes;
  const elapsed = Date.now() - heartbeat.startedAt;
  if (elapsed < 0 || elapsed >= heartbeat.durationMs) return bytes;
  const offset = heartbeat.address - address;
  if (offset < 0 || offset >= bytes.length) return bytes;
  const ticks = Math.floor(elapsed / HEARTBEAT_GRANULARITY_MS);
  bytes[offset] = (heartbeat.baseValue + ticks) & 0xff;
  return bytes;
}

/**
 * Any explicit write covering the heartbeat address means a client has taken
 * over screen RAM, so end the simulated "alive" window and let the real stored
 * bytes show through again. This keeps a lingering heartbeat from corrupting a
 * later writeMemory/readMemory round-trip in a shared-server test.
 */
function cancelHeartbeatOnWrite(state, address, length) {
  const heartbeat = state.heartbeat;
  if (!heartbeat) return;
  if (address <= heartbeat.address && heartbeat.address < address + length) {
    state.heartbeat = null;
  }
}

function seedReadyPrompt(state) {
  const text = "READY.";
  const buffer = new Uint8Array(text.length + 1);
  for (let i = 0; i < text.length; i += 1) {
    buffer[i] = toScreenCode(text[i]);
  }
  buffer[text.length] = toScreenCode(" ");
  state.memory.set(buffer, 0x0400);
}

export async function startMockC64Server(options = {}) {
  const state = createInitialState();
  const streamRuntime = createStreamRuntime();
  state.networkPassword = typeof options.networkPassword === "string" && options.networkPassword.trim()
    ? options.networkPassword
    : null;

  // seed memory with READY prompt at $0400 using screen codes
  seedReadyPrompt(state);

  function ensureDriveState(id) {
    if (!state.drives[id]) {
      state.drives[id] = {
        mountedImage: null,
        mode: "1541",
        power: "off",
        resetCount: 0,
        lastRom: null,
      };
    }
    return state.drives[id];
  }

  ensureDriveState("drive8");

  function resetState() {
    stopAllStreams();
    const fresh = createInitialState();
    Object.assign(state, fresh);
    seedReadyPrompt(state);
    ensureDriveState("drive8");
  }

  function stopAllStreams() {
    for (const stream of Object.keys(streamRuntime)) {
      stopStreamEmitter(stream);
    }
  }

  function stopStreamEmitter(stream) {
    const runtime = streamRuntime[stream];
    if (!runtime) {
      return;
    }
    if (runtime.interval) {
      clearInterval(runtime.interval);
      runtime.interval = null;
    }
    if (runtime.socket) {
      runtime.socket.close();
      runtime.socket = null;
    }
  }

  function startStreamEmitter(stream, target) {
    stopStreamEmitter(stream);
    if (!target || (stream !== "video" && stream !== "audio")) {
      return;
    }

    const runtime = streamRuntime[stream];
    const { host, port } = parseStreamTarget(target, stream === "video" ? 11000 : 11001);
    const socket = dgram.createSocket("udp4");
    runtime.socket = socket;

    if (stream === "video") {
      const sendFrame = () => {
        const packets = buildMockVideoFramePackets(runtime.frameNumber, runtime.sequence);
        runtime.frameNumber = (runtime.frameNumber + 1) & 0xffff;
        runtime.sequence = (runtime.sequence + packets.length) & 0xffff;
        for (const packet of packets) {
          socket.send(packet, port, host);
          state.streams.video.packetsSent += 1;
        }
      };
      sendFrame();
      runtime.interval = setInterval(sendFrame, 30);
      return;
    }

    const sendAudioPacket = () => {
      const packet = buildMockAudioPacket(runtime.sequence, runtime.sampleIndex);
      runtime.sequence = (runtime.sequence + 1) & 0xffff;
      runtime.sampleIndex += 192;
      socket.send(packet, port, host);
      state.streams.audio.packetsSent += 1;
    };

    sendAudioPacket();
    runtime.interval = setInterval(sendAudioPacket, 4);
  }

  const server = createServer(async (req, res) => {
    const { method, url } = req;

    if (!method || !url) {
      res.statusCode = 400;
      res.end();
      return;
    }

    // Track last request metadata
    state.lastRequest = { method, url, headers: req.headers };

    if (state.networkPassword && req.headers["x-password"] !== state.networkPassword) {
      sendJson(res, { message: "Forbidden", errors: ["invalid network password"] }, 403);
      return;
    }

    // Test hook: simulate real firmware soft-failures, which answer HTTP 200
    // with a non-empty `errors` array rather than a non-2xx status. Consumed
    // once so a single forced failure does not leak into later requests.
    if (state.forcedErrors && (!state.forcedErrorsUrlMatch || url.includes(state.forcedErrorsUrlMatch))) {
      const errors = state.forcedErrors;
      state.forcedErrors = null;
      state.forcedErrorsUrlMatch = null;
      // Drain any request body so an unread upload cannot corrupt a reused
      // keep-alive connection's framing.
      for await (const _chunk of req) { /* discard */ }
      sendJson(res, { result: "error", errors });
      return;
    }

    if (method === "GET" && (url === "/" || url.startsWith("/?"))) {
      sendJson(res, { status: "ok", host: "mock" });
      return;
    }

    if (method === "GET" && url === "/v1/version") {
      sendJson(res, { version: "0.1-mock" });
      return;
    }

    if (method === "GET" && url === "/v1/info") {
      sendJson(res, { product: "U64-MOCK", firmware_version: "3.12-mock", hostname: "mockc64" });
      return;
    }

    if (method === "GET" && url === "/v1/drives") {
      const drives = {};
      for (const [driveId, driveState] of Object.entries(state.drives)) {
        drives[driveId] = {
          enabled: driveState.power !== "off",
          power: driveState.power,
          mode: driveState.mode,
          // Mirror the real firmware's DriveInfo shape (image_path is a
          // plain string), not the internal mount-params object.
          image_path: driveState.mountedImage?.image ?? null,
          type: driveState.mountedImage?.type ?? driveState.mode ?? null,
        };
      }
      sendJson(res, { drives });
      return;
    }

    if (method === "PUT" && url === "/v1/machine:pause") {
      state.paused = true;
      state.lastPause = Date.now();
      sendJson(res, { result: "paused" });
      return;
    }

    if (method === "PUT" && url === "/v1/machine:resume") {
      state.paused = false;
      state.lastResume = Date.now();
      sendJson(res, { result: "resumed" });
      return;
    }

    if (method === "PUT" && url === "/v1/machine:poweroff") {
      state.poweroffs += 1;
      state.lastPoweroff = Date.now();
      sendJson(res, { result: "poweroff" });
      return;
    }

    if (method === "PUT" && url === "/v1/machine:menu_button") {
      state.menuToggleCount += 1;
      const target = req.headers["x-target"] ?? null;
      state.lastMenuTarget = target;
      sendJson(res, { result: "menu", target });
      return;
    }

    if (method === "GET" && url === "/v1/machine:menu_screen") {
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(state.menuScreen);
      return;
    }

    if (method === "GET" && url === "/v1/machine:input") {
      if (state.hangOnMachineInputProbe) {
        // Test hook: never respond, to prove a caller cannot be blocked on
        // this probe (HARD01-031). Deliberately does not call res.end().
        return;
      }
      sendJson(res, state.inputState);
      return;
    }

    if (method === "POST" && url === "/v1/machine:input") {
      const batch = await readJson(req);
      for (const event of batch.events ?? []) {
        if (event.kind === "release_all") {
          state.inputState.keyboard.inputs = [];
          state.inputState.joysticks.forEach((joystick) => { joystick.inputs = []; });
          continue;
        }
        const target = event.kind === "keyboard"
          ? state.inputState.keyboard
          : state.inputState.joysticks.find((joystick) => joystick.port === event.port);
        if (!target) continue;
        const inputs = new Set(target.inputs);
        for (const input of event.inputs ?? []) {
          if (event.transition === "release") inputs.delete(input);
          else if (event.transition === "press") inputs.add(input);
          else if (event.transition === "tap") {
            inputs.add(input);
            inputs.delete(input);
          }
        }
        target.inputs = [...inputs];
      }
      sendJson(res, state.inputState);
      return;
    }

    if (method === "GET" && url === "/v1/machine:debugreg") {
      sendJson(res, { value: state.debugreg ?? "00" });
      return;
    }

    if (method === "PUT" && url.startsWith("/v1/machine:debugreg")) {
      const routeUrl = new URL(url, "http://mock.local");
      const value = (routeUrl.searchParams.get("value") ?? "00").toUpperCase();
      state.debugreg = value;
      sendJson(res, { value });
      return;
    }

    if (method === "POST" && url === "/v1/runners:run_prg") {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }

      const prg = Buffer.concat(chunks);
      state.lastPrg = prg;
      state.runCount += 1;

      sendJson(res, { result: "ok", bytes: prg.length });
      return;
    }

    if (method === "POST" && url === "/v1/runners:load_prg") {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }

      const prg = Buffer.concat(chunks);
      state.lastLoadedPrg = prg;
      state.loadCount += 1;

      // Mirror real firmware: place the PRG body at its embedded load
      // address without starting it (no RUN, no BASIC pointer changes).
      if (prg.length >= 2) {
        const loadAddress = prg.readUInt16LE(0);
        state.memory.set(prg.subarray(2), loadAddress);
      }

      sendJson(res, { result: "ok", bytes: prg.length });
      return;
    }

    if (url.startsWith("/v1/runners:sidplay")) {
      let routeUrl;
      try {
        routeUrl = new URL(url, "http://mock.local");
      } catch {
        routeUrl = null;
      }

      if (routeUrl) {
        const songnrParam = routeUrl.searchParams.get("songnr");
        const songnr = songnrParam === null ? null : Number.parseInt(songnrParam, 10);

        if (method === "PUT") {
          const file = routeUrl.searchParams.get("file") ?? "";
          state.sidplayCount += 1;
          state.lastSidplay = { file, songnr };
          sendJson(res, { result: "sidplay", file, songnr });
          return;
        }

        if (method === "POST") {
          const chunks = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }

          const attachment = Buffer.concat(chunks);
          state.sidAttachmentCount += 1;
          state.lastSidAttachment = { songnr, bytes: attachment.length };
          sendJson(res, { result: "sidplay_attachment", bytes: attachment.length, songnr });
          return;
        }
      }
    }

    if (url.startsWith("/v1/runners:modplay")) {
      let routeUrl;
      try {
        routeUrl = new URL(url, "http://mock.local");
      } catch {
        routeUrl = null;
      }

      if (routeUrl) {
        if (method === "PUT") {
          const file = routeUrl.searchParams.get("file") ?? "";
          state.modplayCount += 1;
          state.lastModplay = { file };
          sendJson(res, { result: "modplay", file });
          return;
        }

        if (method === "POST") {
          const chunks = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }

          const attachment = Buffer.concat(chunks);
          state.modplayCount += 1;
          state.lastModplay = { file: null, bytes: attachment.length };
          sendJson(res, { result: "modplay_attachment", bytes: attachment.length });
          return;
        }
      }
    }

    if (method === "GET" && url.startsWith("/v1/machine:readmem")) {
      const routeUrl = new URL(url, "http://mock.local");
      const addressValue = routeUrl.searchParams.get("address") ?? "0";
      const lengthValue = routeUrl.searchParams.get("length") ?? "256";
      const address = parseNumeric(addressValue);
      const length = Math.max(0, parseNumeric(lengthValue, 10));
      const bytes = readMemoryWithHeartbeat(state, address, length);

      const accept = String(req.headers["accept"] || "");
      if (accept.includes("application/octet-stream")) {
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(Buffer.from(bytes));
      } else {
        const payload = Buffer.from(bytes).toString("base64");
        sendJson(res, { data: payload });
      }
      return;
    }

    if (method === "PUT" && url === "/v1/machine:reset") {
      state.resets += 1;
      sendJson(res, { result: "reset" });
      return;
    }

    if (method === "PUT" && url === "/v1/machine:reboot") {
      state.reboots += 1;
      sendJson(res, { result: "reboot" });
      return;
    }

    if (method === "PUT" && url.startsWith("/v1/machine:writemem")) {
      const routeUrl = new URL(url, "http://mock.local");
      const addressValue = routeUrl.searchParams.get("address") ?? "0";
      const dataValue = normaliseHexString(routeUrl.searchParams.get("data") ?? "");
      const address = parseNumeric(addressValue);
      const bytes = Buffer.from(dataValue, "hex");

      state.memory.set(bytes, address);
      state.lastWrite = { address, bytes };
      state.writeLog.push({ address, bytes: Buffer.from(bytes) });
      cancelHeartbeatOnWrite(state, address, bytes.length);
      simulateKeyboardDrain(state, address);

      sendJson(res, { result: "wrote", address, length: bytes.length });
      return;
    }

    if (method === "POST" && url.startsWith("/v1/machine:writemem")) {
      const routeUrl = new URL(url, "http://mock.local");
      const addressValue = routeUrl.searchParams.get("address") ?? "0";
      const address = parseNumeric(addressValue);

      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);

      state.memory.set(bytes, address);
      state.lastWrite = { address, bytes };
      state.writeLog.push({ address, bytes: Buffer.from(bytes) });
      cancelHeartbeatOnWrite(state, address, bytes.length);
      simulateKeyboardDrain(state, address);

      sendJson(res, { result: "wrote", address, length: bytes.length });
      return;
    }

    if (method === "GET" && url === "/v1/configs") {
      sendJson(res, { categories: Object.keys(state.configs), configs: state.configs });
      return;
    }

    if (method === "POST" && url === "/v1/configs") {
      const payload = await readJson(req);
      if (payload && typeof payload === "object") {
        for (const [category, items] of Object.entries(payload)) {
          if (!state.configs[category]) {
            state.configs[category] = {};
          }
          if (items && typeof items === "object") {
            for (const [item, value] of Object.entries(items)) {
              state.configs[category][item] = String(value);
            }
          }
        }
      }
      state.lastConfigAction = { action: "batch_update", payload };
      sendJson(res, { result: "batch_update", categories: Object.keys(payload ?? {}) });
      return;
    }

    if (url.startsWith("/v1/configs:")) {
      const routeUrl = new URL(url, "http://mock.local");
      const action = routeUrl.pathname.slice("/v1/configs:".length);

      if (method === "PUT" && action === "load_from_flash") {
        if (state.flashSnapshot) {
          state.configs = JSON.parse(JSON.stringify(state.flashSnapshot));
        }
        state.lastConfigAction = { action: "load_from_flash" };
        sendJson(res, { result: "loaded", restored: Boolean(state.flashSnapshot) });
        return;
      }

      if (method === "PUT" && action === "save_to_flash") {
        state.flashSnapshot = JSON.parse(JSON.stringify(state.configs));
        state.lastConfigAction = { action: "save_to_flash" };
        sendJson(res, { result: "saved" });
        return;
      }

      if (method === "PUT" && action === "reset_to_default") {
        state.configs = createDefaultConfigs();
        state.lastConfigAction = { action: "reset_to_default" };
        sendJson(res, { result: "reset" });
        return;
      }
    }

    if (url.startsWith("/v1/configs/")) {
      const routeUrl = new URL(url, "http://mock.local");
      const segments = routeUrl.pathname.split("/").filter(Boolean).slice(2); // remove v1 + configs

      if (segments.length === 1) {
        const [category] = segments;

        if (method === "GET") {
          const categoryData = state.configs[category] ?? {};
          sendJson(res, { ...categoryData });
          return;
        }
      }

      if (segments.length === 2) {
        const [category, item] = segments;
        if (method === "GET") {
          const categoryData = state.configs[category] ?? {};
          const value = categoryData[item];
          sendJson(res, { value });
          return;
        }

        if (method === "PUT") {
          const queryValue = routeUrl.searchParams.get("value");
          const body = await readJson(req);
          const value = queryValue ?? body?.value ?? "";
          if (!state.configs[category]) {
            state.configs[category] = {};
          }
          state.configs[category][item] = String(value);
          state.lastConfigAction = { action: "set", category, item, value: String(value) };
          sendJson(res, { result: "updated", category, item, value: String(value) });
          return;
        }
      }
    }

    if (url.startsWith("/v1/streams/")) {
      const routeUrl = new URL(url, "http://mock.local");
      const match = /^\/v1\/streams\/([^:]+):(start|stop)$/.exec(routeUrl.pathname);
      if (match) {
        const stream = decodeURIComponent(match[1]);
        const action = match[2];
        if (!state.streams[stream]) {
          state.streams[stream] = { active: false, target: null };
        }

        if (action === "start" && method === "PUT") {
          const body = await readJson(req);
          const target = routeUrl.searchParams.get("ip") ?? routeUrl.searchParams.get("target") ?? body?.ip ?? body?.target ?? null;
          state.streams[stream] = { active: true, target, packetsSent: 0 };
          state.lastStreamAction = { action: "start", stream, target };
          state.streamActionLog.push({ action: "start", stream, target });
          startStreamEmitter(stream, target);
          sendJson(res, { result: "started", stream, target });
          return;
        }

        if (action === "stop" && method === "PUT") {
          stopStreamEmitter(stream);
          state.streams[stream] = { active: false, target: null, packetsSent: state.streams[stream]?.packetsSent ?? 0 };
          state.lastStreamAction = { action: "stop", stream };
          state.streamActionLog.push({ action: "stop", stream });
          sendJson(res, { result: "stopped", stream });
          return;
        }
      }
    }

    if (url.startsWith("/v1/drives/")) {
      let routeUrl;
      try {
        routeUrl = new URL(url, "http://mock.local");
      } catch {
        routeUrl = null;
      }
      if (routeUrl) {
        const match = /^\/v1\/drives\/([^:]+):(mount|remove|reset|on|off|load_rom|set_mode)$/.exec(routeUrl.pathname);
        if (match) {
          const driveId = decodeURIComponent(match[1]);
          const action = match[2];
          const driveState = ensureDriveState(driveId);

          const respond = (payload) => {
            sendJson(res, payload);
          };

          state.lastDriveOperation = {
            action,
            drive: driveId,
            params: Object.fromEntries(routeUrl.searchParams.entries()),
            method,
          };

          if (action === "mount" && method === "PUT") {
            const image = routeUrl.searchParams.get("image") ?? "";
            const type = routeUrl.searchParams.get("type") ?? null;
            const mode = routeUrl.searchParams.get("mode") ?? null;
            driveState.mountedImage = {
              image,
              type,
              mode,
            };
            respond({ result: "mounted", drive: driveId, image, type, mode });
            return;
          }

          if (action === "remove" && method === "PUT") {
            driveState.mountedImage = null;
            respond({ result: "removed", drive: driveId });
            return;
          }

          if (action === "reset" && method === "PUT") {
            driveState.resetCount += 1;
            respond({ result: "reset", drive: driveId, count: driveState.resetCount });
            return;
          }

          if (action === "on" && method === "PUT") {
            driveState.power = "on";
            respond({ result: "power_on", drive: driveId });
            return;
          }

          if (action === "off" && method === "PUT") {
            driveState.power = "off";
            respond({ result: "power_off", drive: driveId });
            return;
          }

          if (action === "load_rom" && (method === "PUT" || method === "POST")) {
            const file = routeUrl.searchParams.get("file") ?? "";
            driveState.lastRom = file;
            respond({ result: "rom_loaded", drive: driveId, file });
            return;
          }

          if (action === "set_mode" && method === "PUT") {
            const mode = routeUrl.searchParams.get("mode") ?? "1541";
            driveState.mode = mode;
            respond({ result: "mode_set", drive: driveId, mode });
            return;
          }
        }
      }
    }

    if (url.startsWith("/v1/files/")) {
      let routeUrl;
      try {
        routeUrl = new URL(url, "http://mock.local");
      } catch {
        routeUrl = null;
      }
      if (routeUrl) {
        const match = /^\/v1\/files\/([^:]+):(info|create_d64|create_d71|create_d81|create_dnp)$/.exec(routeUrl.pathname);
        if (match) {
          const encodedPath = match[1];
          const action = match[2];
          const decodedPath = decodeURIComponent(encodedPath);

          const respond = (payload) => {
            sendJson(res, payload);
          };

          if (action === "info" && method === "GET") {
            state.lastFileInfo = decodedPath;
            respond({ path: decodedPath, size: 4096, type: "file" });
            return;
          }

          if (action === "create_d64" && method === "PUT") {
            const tracks = Number.parseInt(routeUrl.searchParams.get("tracks") ?? "35", 10);
            const diskname = routeUrl.searchParams.get("diskname") ?? null;
            state.createdImages.push({ type: "d64", path: decodedPath, tracks, diskname });
            respond({ result: "created", type: "d64", path: decodedPath, tracks, diskname });
            return;
          }

          if (action === "create_d71" && method === "PUT") {
            const diskname = routeUrl.searchParams.get("diskname") ?? null;
            state.createdImages.push({ type: "d71", path: decodedPath, diskname });
            respond({ result: "created", type: "d71", path: decodedPath, diskname });
            return;
          }

          if (action === "create_d81" && method === "PUT") {
            const diskname = routeUrl.searchParams.get("diskname") ?? null;
            state.createdImages.push({ type: "d81", path: decodedPath, diskname });
            respond({ result: "created", type: "d81", path: decodedPath, diskname });
            return;
          }

          if (action === "create_dnp" && method === "PUT") {
            const tracks = Number.parseInt(routeUrl.searchParams.get("tracks") ?? "0", 10);
            const diskname = routeUrl.searchParams.get("diskname") ?? null;
            state.createdImages.push({ type: "dnp", path: decodedPath, tracks, diskname });
            respond({ result: "created", type: "dnp", path: decodedPath, tracks, diskname });
            return;
          }
        }
      }
    }

    res.statusCode = 404;
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine mock server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    async close() {
      stopAllStreams();
      server.close();
      await once(server, "close");
    },
    reset: resetState,
  };
}

function parseStreamTarget(value, defaultPort) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return { host: "127.0.0.1", port: defaultPort };
  }
  const separator = trimmed.lastIndexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return { host: trimmed, port: defaultPort };
  }
  const host = trimmed.slice(0, separator);
  const port = Number.parseInt(trimmed.slice(separator + 1), 10);
  return {
    host,
    port: Number.isFinite(port) && port > 0 && port <= 65535 ? port : defaultPort,
  };
}

function buildMockVideoFramePackets(frameNumber, sequenceStart) {
  const width = 384;
  const height = 272;
  const linesPerPacket = 4;
  const bytesPerLine = width / 2;
  const packets = [];
  let sequence = sequenceStart & 0xffff;

  for (let line = 0; line < height; line += linesPerPacket) {
    const header = Buffer.alloc(12);
    header.writeUInt16LE(sequence, 0);
    header.writeUInt16LE(frameNumber & 0xffff, 2);
    const isLastPacket = line + linesPerPacket >= height;
    header.writeUInt16LE(isLastPacket ? (line | 0x8000) : line, 4);
    header.writeUInt16LE(width, 6);
    header.writeUInt8(linesPerPacket, 8);
    header.writeUInt8(4, 9);
    header.writeUInt16LE(0, 10);

    const payload = Buffer.alloc(bytesPerLine * linesPerPacket);
    let offset = 0;
    for (let y = 0; y < linesPerPacket; y += 1) {
      const absoluteLine = line + y;
      for (let x = 0; x < width; x += 2) {
        const low = (frameNumber + absoluteLine + x) & 0x0f;
        const high = (frameNumber + absoluteLine + x + 1) & 0x0f;
        payload[offset++] = low | (high << 4);
      }
    }

    packets.push(Buffer.concat([header, payload]));
    sequence = (sequence + 1) & 0xffff;
  }

  return packets;
}

function buildMockAudioPacket(sequence, sampleIndex) {
  const header = Buffer.alloc(2);
  header.writeUInt16LE(sequence & 0xffff, 0);

  const payload = Buffer.alloc(768);
  for (let index = 0; index < 192; index += 1) {
    const phase = ((sampleIndex + index) % 256) - 128;
    const left = phase * 128;
    const right = -left;
    payload.writeInt16LE(left, index * 4);
    payload.writeInt16LE(right, index * 4 + 2);
  }

  return Buffer.concat([header, payload]);
}
