import test from "#test/runner";
import assert from "#test/assert";
import net from "node:net";
import { startViceProcess } from "../src/vice/process.js";

async function closedLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("HARD03-013 startViceProcess rejects when Xvfb is not installed instead of crashing the process", async (t) => {
  const saved = { PATH: process.env.PATH, FORCE_XVFB: process.env.FORCE_XVFB, VICE_HEADLESS: process.env.VICE_HEADLESS };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.FORCE_XVFB = "1";
  delete process.env.VICE_HEADLESS;
  process.env.PATH = "/nonexistent-bin-dir";
  const port = await closedLoopbackPort();
  await assert.rejects(
    () => startViceProcess({ binary: "/nonexistent/x64sc", host: "127.0.0.1", port, visible: false }),
    /Xvfb.*(not installed|not found)|DISPLAY/,
  );
});

test("VICE-17 the emulator child does not inherit the bridge token, passwords or C64BRIDGE_* settings", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vice-env-"));
  const out = path.join(dir, "env.json");
  const fake = path.join(dir, "fake-vice.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));
const port = Number(process.argv[process.argv.indexOf("-binarymonitoraddress") + 1].split(":")[1]);
net.createServer((s) => s.on("data", () => {})).listen(port, "127.0.0.1");
`, { mode: 0o755 });
  const names = ["C64BRIDGE_HTTP_TOKEN", "C64U_PASSWORD", "C64BRIDGE_ACCESS", "SOME_KEEP_ME", "VICE_HEADLESS"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  process.env.C64BRIDGE_HTTP_TOKEN = "t0ken";
  process.env.C64U_PASSWORD = "pw";
  process.env.C64BRIDGE_ACCESS = "full";
  process.env.SOME_KEEP_ME = "kept";
  const port = await closedLoopbackPort();
  const handle = await startViceProcess({ binary: fake, host: "127.0.0.1", port, headless: true, warp: false });
  t.after(async () => {
    await handle.stop();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const env = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(env.SOME_KEEP_ME, "kept");
  assert.equal(env.C64BRIDGE_HTTP_TOKEN, undefined);
  assert.equal(env.C64U_PASSWORD, undefined);
  assert.equal(env.C64BRIDGE_ACCESS, undefined);
});
