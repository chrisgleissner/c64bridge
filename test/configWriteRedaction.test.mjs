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

test("configuration argument redaction covers legacy, mixed and literal updates categories", () => {
  const payloads = [
    [
      { "Network settings": { "Network Password": "legacy-secret" } },
      { "Network settings": { "Network Password": "***" } },
    ],
    [
      { updates: { Audio: { Volume: 80 } }, "Network settings": { "Network Password": "mixed-secret" } },
      { updates: { Audio: { Volume: "***" } }, "Network settings": { "Network Password": "***" } },
    ],
    [
      { updates: { "Network settings": { "Network Password": "wrapped-secret" } }, Audio: { Volume: 80 } },
      { updates: { "Network settings": { "Network Password": "***" } }, Audio: { Volume: "***" } },
    ],
    [
      { updates: { "Network Password": "literal-updates-secret" } },
      { updates: { "Network Password": "***" } },
    ],
  ];
  for (const [payload, expected] of payloads) {
    assert.deepEqual(redactToolArguments("c64_config", { op: "batch_update", ...payload }), { op: "batch_update", ...expected });
    assert.deepEqual(redactToolArguments("config_batch_update", payload), expected);
    assert.deepEqual(redactToolArguments("c64_batch", {
      commands: [{ tool: "c64_config", args: { op: "batch_update", ...payload } }],
    }), { commands: [{ tool: "c64_config", args: { op: "batch_update", ...expected } }] });
  }
});

test("HARD03-006 diagnostics omit values from set, legacy and mixed batch configuration calls", async (t) => {
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
  const batchSecrets = ["zz-legacy-password-83c", "zz-mixed-password-14d", "zz-nested-password-28e"];
  await client.callTool({ name: "c64_config", arguments: {
    op: "batch_update", "Network settings": { "Network Password": batchSecrets[0] },
  } });
  await client.callTool({ name: "c64_config", arguments: {
    op: "batch_update", updates: { "Audio Mixer": { Volume: 80 } },
    "Network settings": { "Network Password": batchSecrets[1] },
  } });
  await client.callTool({ name: "c64_batch", arguments: { commands: [{ tool: "c64_config", args: {
    op: "batch_update", "Network settings": { "Network Password": batchSecrets[2] },
  } }] } });
  const files = fs.readdirSync(diagnosticsDir).filter((file) => file.endsWith(".ndjson"));
  assert.ok(files.length > 0, "a diagnostics file exists");
  const text = files.map((file) => fs.readFileSync(path.join(diagnosticsDir, file), "utf8")).join("\n");
  assert.ok(text.includes("mcp_call_tool_start"), "the call was recorded");
  assert.ok(text.includes("Network P?ssword"), "the item name is recorded");
  assert.equal(text.includes(secretValue), false);
  for (const secret of batchSecrets) assert.equal(text.includes(secret), false);
});
