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
