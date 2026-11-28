// A private real VICE behind the MCP server, for the device runs (npm run test:vice:device).
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConnectedClient } from "./mcpTestClient.mjs";

export const realVice = process.env.VICE_TEST_TARGET === "vice" && process.env.VICE_AVAILABLE === "1";

/** Runs `fn(call)` against a managed VICE; `call` returns the data of a successful tool result. */
export async function realViceSession({ port, display }, fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-gd1-"));
  const config = path.join(directory, "config.json");
  // Only VICE is configured, so the run cannot contact a hardware backend.
  fs.writeFileSync(config, JSON.stringify({ vice: { host: "127.0.0.1", port } }));
  const connection = await createConnectedClient({
    env: {
      C64_MODE: "vice", C64BRIDGE_CONFIG: config, VICE_PORT: String(port), VICE_XVFB_DISPLAY: display,
      FORCE_XVFB: "1", VICE_VISIBLE: "false", VICE_WARP: "true", VICE_TEST_TARGET: "", VICE_ARGS: "-sounddev dummy",
    },
  });
  const call = async (name, args) => {
    const result = await connection.client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    assert.ok(!result.isError, `${name} ${args.op}: ${JSON.stringify(result.content)}`);
    return result.structuredContent.data;
  };
  try {
    await fn(call);
  } finally {
    await connection.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
