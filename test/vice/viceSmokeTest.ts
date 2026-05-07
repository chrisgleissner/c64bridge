#!/usr/bin/env node
/*
 * VICE Binary Monitor smoke test (TypeScript)
 */
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { ViceClient } from "../../src/vice/viceClient.js";
import { waitForScreenPattern, waitForStableScreenPattern, buildReadyPattern, waitForAnyScreenText } from "../../src/vice/readiness.js";
import { resolveViceSmokeOptions } from "../../src/vice/smokeOptions.js";
import { startViceMockServer, type ViceMockServer } from "../../src/vice/mockServer.js";

type Timing = { label: string; ms: number };
function nowNs(): bigint { return process.hrtime.bigint(); }
function msSince(start: bigint): number { return Number((process.hrtime.bigint() - start) / 1_000_000n); }
function log(label: string) { console.log(`[+] ${label}`); }
function logT(sink: Timing[], label: string, start: bigint) { const ms = msSince(start); sink.push({ label, ms }); console.log(`[t] ${label}=${ms}ms`); }

function forwardChildStreamOutput(child: ChildProcess, label: string): void {
  const forward = (stream: NodeJS.ReadableStream | null | undefined, target: NodeJS.WriteStream, streamLabel: "stdout" | "stderr") => {
    if (!stream) {
      return;
    }
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) {
        if (!line) {
          continue;
        }
        target.write(`[${label} ${streamLabel}] ${line}\n`);
      }
    });
  };

  forward(child.stdout, process.stdout, "stdout");
  forward(child.stderr, process.stderr, "stderr");
  child.once("exit", (code, signal) => {
    const detail = signal ? `signal=${signal}` : `code=${code ?? 0}`;
    log(`${label} exited (${detail})`);
  });
}

const smokeOptions = resolveViceSmokeOptions(process.env, process.argv.slice(2));
const USE_MOCK = smokeOptions.useMock;
const VICE_BIN = process.env.VICE_BINARY || "x64sc";
const CONFIGURED_PORT = smokeOptions.configuredPort;
const HAS_EXPLICIT_PORT = smokeOptions.hasExplicitPort;
const VISIBLE = smokeOptions.visible;
const KEEP_OPEN = smokeOptions.keepOpen;
const WARP = smokeOptions.warp;
const DISPLAY = smokeOptions.display;
const VISIBLE_DEMO = smokeOptions.visibleDemo;

function shouldUseXvfb(): boolean {
  if (USE_MOCK || VISIBLE) return false;
  if (process.env.FORCE_XVFB === "1") return true;
  const ci = (process.env.CI || "").toLowerCase();
  return ci === "true" || ci === "1" || ci === "yes";
}

function buildViceArgs(port: number): string[] {
  const args = [
    "-binarymonitor",
    "-binarymonitoraddress", `127.0.0.1:${port}`,
    "-sounddev", "dummy",
    "-config", "/dev/null",
  ];
  if (WARP) args.push("-warp");
  return args;
}

async function waitForPort(port: number, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.connect({ host: "127.0.0.1", port }, () => { s.end(); resolve(); });
        s.on("error", reject);
        s.setTimeout(300, () => { s.destroy(new Error("timeout")); });
      });
      return;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timeout waiting for port ${port}`);
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("Failed to reserve an ephemeral loopback port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

/**
 * Construct a minimal tokenised BASIC program that prints "HELLO" once.
 *
 * Layout:
 * - $0801: start of BASIC program area
 * - Line 10 (0x000A) with PRINT token ($99) followed by "HELLO"
 * - Two zero bytes terminate the line and program
 */
function buildHelloProgramBody(): Buffer {
  return Buffer.from([
    0x0E,0x08, // next line pointer -> $080E
    0x0A,0x00, // BASIC line 10
    0x99, // PRINT token
    0x22,0x48,0x45,0x4C,0x4C,0x4F,0x22,
    0x00,
    0x00,0x00, // end of line, end of program
  ]);
}

async function main() {
  const timings: Timing[] = [];
  let xvfb: ChildProcess | null = null;
  let vice: ChildProcess | null = null;
  let bm: ViceClient | null = null;
  let mock: (ViceMockServer & { port: number }) | null = null;
  let port = CONFIGURED_PORT;

  const cleanup = async () => {
    if (bm) {
      try { await bm.quit(); } catch {}
      try { bm.close(); } catch {}
      bm = null;
    }
    if (vice && !KEEP_OPEN) { try { vice.kill("SIGTERM"); } catch {} vice = null; }
    if (mock) { try { await mock.stop(); } catch {}; mock = null; }
    if (xvfb) { try { xvfb.kill("SIGTERM"); } catch {} xvfb = null; }
  };

  process.on("exit", () => { void cleanup(); });
  process.on("SIGINT", () => { void cleanup().then(() => process.exit(130)); });
  process.on("SIGTERM", () => { void cleanup().then(() => process.exit(143)); });
  process.on("uncaughtException", () => { void cleanup(); });
  process.on("unhandledRejection", () => { void cleanup(); });

  try {
    if (!USE_MOCK && shouldUseXvfb()) {
      log(`Starting Xvfb on ${DISPLAY}...`);
      const t0 = nowNs();
      xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", "640x480x24"], { stdio: ["ignore", "pipe", "pipe"] });
      forwardChildStreamOutput(xvfb, "xvfb");
      logT(timings, "spawn_xvfb", t0);
      process.env.DISPLAY = DISPLAY;
      await new Promise(r => setTimeout(r, 300));
    }

    if (USE_MOCK) {
      mock = await startViceMockServer({
        host: "127.0.0.1",
        port: HAS_EXPLICIT_PORT && CONFIGURED_PORT > 0 ? CONFIGURED_PORT : undefined,
      });
      port = mock.port;
      log(`[+] Using VICE mock server on port ${port}`);
    } else {
      if (!HAS_EXPLICIT_PORT) {
        port = await reserveLoopbackPort();
      }
      const args = buildViceArgs(port);
      log(`Launching VICE binary: ${VICE_BIN} ${args.join(" ")}`);
      const t1 = nowNs();
      vice = spawn(VICE_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
      forwardChildStreamOutput(vice, "vice");
      logT(timings, "spawn_vice", t1);

      log(`Waiting for BM port ${port}...`);
      const t2 = nowNs();
      await waitForPort(port, 4000);
      logT(timings, "wait_port", t2);
    }

    bm = new ViceClient();
    const t3 = nowNs();
    await bm.connect(port);
    await bm.info();
    logT(timings, "bm_info", t3);

    if (VISIBLE_DEMO && !USE_MOCK) {
      log("Visible demo mode enabled: waiting for a stable READY screen before injecting HELLO.");
    }

    const t4 = nowNs();
    await bm.reset(USE_MOCK || !WARP || VISIBLE ? 1 : 0);
    logT(timings, "bm_reset", t4);

    await new Promise(r => setTimeout(r, 250));
    await bm.keyboardFeed("\r\r\r");
    const readyStart = nowNs();
    const between = async () => { try { await bm!.exitMonitor(); } catch {} };
    const anyText = await waitForAnyScreenText(bm, 10_000, 50, undefined, between);
    if (!anyText) throw new Error("Screen stayed blank (no text) after reset");
    const readyIdx = VISIBLE_DEMO
      ? await waitForStableScreenPattern(bm, buildReadyPattern(), 10_000, 150, 3, undefined, between)
      : await waitForScreenPattern(bm, buildReadyPattern(), 10_000, 50, undefined, between);
    logT(timings, "wait_ready", readyStart);
    if (readyIdx < 0) throw new Error("READY. prompt not detected");
    log("[✓] BASIC READY detected");

    if (VISIBLE_DEMO) {
      await new Promise((r) => setTimeout(r, 750));
    }

    const program = buildHelloProgramBody();
    const programEnd = 0x0801 + program.length;
    const t5 = nowNs();
    await bm.memSet(0x0801, program);
    const ptrs = Buffer.alloc(8);
    ptrs.writeUInt16LE(0x0801, 0);
    ptrs.writeUInt16LE(programEnd, 2);
    ptrs.writeUInt16LE(programEnd, 4);
    ptrs.writeUInt16LE(programEnd, 6);
    await bm.memSet(0x002B, ptrs);
    await bm.keyboardFeed("RUN\r");
    logT(timings, "inject_and_run", t5);

    const hello = Buffer.from([0x08, 0x05, 0x0C, 0x0C, 0x0F]);
    const helloStart = nowNs();
    const betweenRun = async () => { try { await bm!.exitMonitor(); } catch {} };
    const idx = await waitForScreenPattern(bm, hello, USE_MOCK || VISIBLE || !WARP ? 10_000 : 2_000, 50, undefined, betweenRun);
    logT(timings, "wait_hello", helloStart);
    if (idx < 0) throw new Error("HELLO not found on screen");
    log(`[✓] HELLO found at row ${Math.floor(idx / 40)}, col ${idx % 40}`);

    if (!KEEP_OPEN) {
      try { await bm.quit(); } catch {}
      try { bm.close(); } catch {}
      bm = null;
    } else {
      log(VISIBLE_DEMO
        ? "Visible VICE demo complete — keeping the emulator window open. Close it to end."
        : "VICE_KEEP_OPEN=1 — keep window open; close it to end.");
      // eslint-disable-next-line no-constant-condition
      while (true) await new Promise(r => setTimeout(r, 1000));
    }

    console.log("[timings]");
    for (const t of timings) console.log(`[timing] ${t.label} ${t.ms}ms`);
  } catch (err) {
    await cleanup();
    throw err;
  } finally {
    if (!KEEP_OPEN) await cleanup();
  }
}

main().catch((err) => {
  console.error("[!] Smoke test failed:", err);
  process.exit(1);
});
