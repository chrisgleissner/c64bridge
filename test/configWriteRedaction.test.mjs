import test from "#test/runner";
import assert from "#test/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";
import { redactToolArguments } from "../src/redact.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("HARD03-006 redactToolArguments replaces configuration write values and keeps names", () => {
  assert.deepEqual(
    redactToolArguments("c64_config", { op: "set", category: "Network settings", item: "Network P?ssword", value: "pw1" }),
    { op: "set", category: "Network settings", item: "Network P?ssword", value: "***" },
  );
  assert.deepEqual(
    redactToolArguments("c64_config", { op: "batch_update", updates: { Net: { A: "pw2", B: 3 } } }),
    { op: "batch_update", updates: { Net: { A: "***", B: "***" } } },
  );
  const batch = redactToolArguments("c64_batch", {
    commands: [{ tool: "c64_config", args: { op: "set", category: "C", item: "I", value: "pw3" } }, { tool: "c64_memory", args: { op: "read", address: "$0400" } }],
  });
  assert.equal(JSON.stringify(batch).includes("pw3"), false);
  assert.deepEqual(redactToolArguments("c64_memory", { op: "read", address: "$0400" }), { op: "read", address: "$0400" });
  assert.deepEqual(redactToolArguments("c64_config", { op: "get", category: "A", item: "B" }), { op: "get", category: "A", item: "B" });
});

test("HARD03-006 the diagnostics record of a c64_config set call does not contain the value", async (t) => {
  const mock = await startMockC64Server();
  t.after(async () => { await mock.close(); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-redact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ c64u: { baseUrl: mock.baseUrl } }), "utf8");
  const diagnosticsDir = path.join(root, "diagnostics");
  const transport = new StdioClientTransport({
    command: process.execPath.includes("bun") ? "node" : process.execPath,
    args: ["--import", "tsx/esm", path.join(repoRoot, "src", "mcp-server.ts")],
    cwd: repoRoot,
    env: {
      ...process.env,
      C64BRIDGE_CONFIG: configPath,
      C64BRIDGE_DIAGNOSTICS_DIR: diagnosticsDir,
      C64BRIDGE_ENABLE_TEST_DIAGNOSTICS: "1",
      C64BRIDGE_DISABLE_DIAGNOSTICS: "0",
      HOME: path.join(root, "home"),
      C64_TEST_TARGET: "mock",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "c64bridge-tests", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  const secretValue = "zz-new-password-9f3";
  await client.callTool({
    name: "c64_config",
    arguments: { op: "set", category: "Network settings", item: "Network P?ssword", value: secretValue },
  });
  const files = fs.readdirSync(diagnosticsDir).filter((file) => file.endsWith(".ndjson"));
  assert.ok(files.length > 0, "a diagnostics file exists");
  const text = files.map((file) => fs.readFileSync(path.join(diagnosticsDir, file), "utf8")).join("\n");
  assert.ok(text.includes("mcp_call_tool_start"), "the call was recorded");
  assert.ok(text.includes("Network P?ssword"), "the item name is recorded");
  assert.equal(text.includes(secretValue), false);
});
