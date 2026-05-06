import test from "#test/runner";
import assert from "#test/assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createConnectedClient } from "./helpers/mcpTestClient.mjs";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";
import { startViceMockServer } from "../src/vice/mockServer.js";

const PLATFORM_RESOURCE_URI = "c64://platform/status";
const REPO_CONFIG_PATH = path.resolve(".c64bridge.json");
const STARTUP_ASSERTION_MS = typeof globalThis.Bun !== "undefined" ? 1_500 : 10_000;
const registerDataUri = "data:text/javascript,import { register } from \"node:module\"; import { pathToFileURL } from \"node:url\"; register(\"ts-node/esm\", pathToFileURL(\"./\"));";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIgnorableSocketTeardownError(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return code === "ECONNRESET" || code === "EPIPE" || text.includes("ECONNRESET") || text.includes("EPIPE");
}

function parsePlatformStatus(text) {
  const match = String(text ?? "").match(/Current platform:\s*`([^`]+)`/i);
  if (!match) {
    return null;
  }
  const platform = match[1].trim().toLowerCase();
  return platform === "c64u" || platform === "vice" ? platform : null;
}

function parseAvailableBackends(text) {
  const matches = Array.from(String(text ?? "").matchAll(/^- `([^`]+)`(?: \((active)\))?$/gm));
  return matches.map((match) => ({
    backend: match[1],
    active: match[2] === "active",
  }));
}

async function waitForDiagnosticEvent(diagDir, eventName) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const files = fs.existsSync(diagDir)
      ? fs.readdirSync(diagDir).filter((entry) => entry.endsWith(".ndjson"))
      : [];
    for (const file of files) {
      const fullPath = path.join(diagDir, file);
      const text = fs.readFileSync(fullPath, "utf8").trim();
      if (!text) {
        continue;
      }
      const records = text.split("\n").map((line) => JSON.parse(line));
      const match = records.find((record) => record.event === eventName);
      if (match) {
        return match;
      }
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for diagnostics event '${eventName}'`);
}

async function withServerConfig(config, env, fn) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await withServerConfigOnce(config, env, fn);
    } catch (error) {
      lastError = error;
      if (!isIgnorableSocketTeardownError(error) || attempt >= 2) {
        throw error;
      }
      await delay(100 * attempt);
    }
  }
  throw lastError;
}

async function withServerConfigOnce(config, env, fn) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-mcp-platform-"));
  const configPath = path.join(tempRoot, "c64bridge.json");
  const diagnosticsDir = path.join(tempRoot, "diagnostics");
  const homeDir = path.join(tempRoot, "home");
  const hadRepoConfig = fs.existsSync(REPO_CONFIG_PATH);
  const originalRepoConfig = hadRepoConfig ? fs.readFileSync(REPO_CONFIG_PATH, "utf8") : null;
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
  const swallowSocketReset = (error) => {
    if (isIgnorableSocketTeardownError(error)) {
      return;
    }
    throw error;
  };
  process.prependListener("uncaughtException", swallowSocketReset);

  try {
    fs.rmSync(REPO_CONFIG_PATH, { force: true });
    const connection = await createConnectedClient({
      env: {
        C64BRIDGE_CONFIG: configPath,
        C64BRIDGE_DIAGNOSTICS_DIR: diagnosticsDir,
        C64BRIDGE_ENABLE_TEST_DIAGNOSTICS: "1",
        C64_TEST_TARGET: "mock",
        C64_MODE: "",
        HOME: homeDir,
        ...env,
      },
    });

    try {
      await fn({
        client: connection.client,
        diagnosticsDir,
        stderrOutput: connection.stderrOutput,
      });
    } finally {
      await connection.close();
    }
  } finally {
    await delay(50);
    process.removeListener("uncaughtException", swallowSocketReset);
    if (hadRepoConfig) {
      fs.writeFileSync(REPO_CONFIG_PATH, originalRepoConfig, "utf8");
    } else {
      fs.rmSync(REPO_CONFIG_PATH, { force: true });
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function probePlatformInitInChild(options) {
  const serializedOptions = JSON.stringify(options);
  const childScript = String.raw`
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js";
    import { createConnectedClient } from "./test/helpers/mcpTestClient.mjs";
    import { startMockC64Server } from "./scripts/mockC64Server.mjs";
    import { startViceMockServer } from "./src/vice/mockServer.ts";

    const options = ${serializedOptions};

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function waitForDiagnosticEvent(diagDir, eventName) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const files = fs.existsSync(diagDir)
          ? fs.readdirSync(diagDir).filter((entry) => entry.endsWith(".ndjson"))
          : [];
        for (const file of files) {
          const fullPath = path.join(diagDir, file);
          const text = fs.readFileSync(fullPath, "utf8").trim();
          if (!text) {
            continue;
          }
          const records = text.split("\n").map((line) => JSON.parse(line));
          const match = records.find((record) => record.event === eventName);
          if (match) {
            return match;
          }
        }
        await delay(50);
      }
      throw new Error("Timed out waiting for diagnostics event '" + eventName + "'");
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-mcp-platform-child-"));
    const configPath = path.join(tempRoot, "c64bridge.json");
    const diagnosticsDir = path.join(tempRoot, "diagnostics");
    const homeDir = path.join(tempRoot, "home");
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    const config = {};
    const shutdown = [];
    if (options.includeC64u) {
      const c64u = await startMockC64Server();
      shutdown.push(() => c64u.close());
      const mockUrl = new URL(c64u.baseUrl);
      config.c64u = {
        host: mockUrl.hostname,
        port: mockUrl.port ? Number(mockUrl.port) : 80,
      };
    }
    if (options.includeVice) {
      const vice = await startViceMockServer({ host: "127.0.0.1", port: 0 });
      shutdown.push(() => vice.stop());
      config.vice = { host: "127.0.0.1", port: vice.port };
    }
    fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

    let connection;
    try {
      connection = await createConnectedClient({
        env: {
          C64BRIDGE_CONFIG: configPath,
          C64BRIDGE_DIAGNOSTICS_DIR: diagnosticsDir,
          C64BRIDGE_ENABLE_TEST_DIAGNOSTICS: "1",
          C64_TEST_TARGET: "mock",
          HOME: homeDir,
          ...options.env,
        },
      });

      const resource = await connection.client.request(
        { method: "resources/read", params: { uri: "c64://platform/status" } },
        ReadResourceResultSchema,
      );
      const event = await waitForDiagnosticEvent(diagnosticsDir, "platform_initialised");
      process.stdout.write(JSON.stringify({
        text: resource.contents?.[0]?.text ?? "",
        eventPlatform: event.details?.platform ?? null,
      }));
    } finally {
      if (connection) {
        await connection.close();
      }
      while (shutdown.length > 0) {
        const stop = shutdown.pop();
        await stop();
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  `;

  const stdoutChunks = [];
  const stderrChunks = [];

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", registerDataUri, "--input-type=module", "--eval", childScript],
      {
        cwd: path.dirname(REPO_CONFIG_PATH),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`Vice platform-init child probe failed with exit code ${exitCode}\n${stderrChunks.join("")}`.trim());
  }

  return JSON.parse(stdoutChunks.join(""));
}

test("mcp-server initialises platform state from the active backend", async (t) => {
  await t.test("startup selects c64u and records platform_initialised", async () => {
    const mock = await startMockC64Server();
    t.after(async () => {
      await mock.close();
    });

    const mockUrl = new URL(mock.baseUrl);
    await withServerConfig(
      {
        c64u: {
          host: mockUrl.hostname,
          port: Number(mockUrl.port),
        },
      },
      {},
      async ({ client, diagnosticsDir }) => {
        const resource = await client.request(
          { method: "resources/read", params: { uri: PLATFORM_RESOURCE_URI } },
          ReadResourceResultSchema,
        );
        const text = resource.contents?.[0]?.text ?? "";

        assert.equal(parsePlatformStatus(text), "c64u");
        assert.deepEqual(parseAvailableBackends(text), [
          { backend: "c64u", active: true },
        ]);
        assert.match(text, /c64_select_backend/);

        const event = await waitForDiagnosticEvent(diagnosticsDir, "platform_initialised");
        assert.equal(event.details?.platform, "c64u");
      },
    );
  });

  await t.test("startup selects vice and records platform_initialised", async () => {
    const probe = await probePlatformInitInChild({
      includeVice: true,
      env: {
        C64_MODE: "vice",
        VICE_TEST_TARGET: "mock",
      },
    });

    assert.equal(parsePlatformStatus(probe.text), "vice");
    assert.deepEqual(parseAvailableBackends(probe.text), [
      { backend: "vice", active: true },
      { backend: "c64u", active: false },
    ]);
    assert.match(probe.text, /c64_select_backend/);
    assert.equal(probe.eventPlatform, "vice");
  });

  await t.test("platform status lists all configured backends and marks the active one", async () => {
    const probe = await probePlatformInitInChild({
      includeC64u: true,
      includeVice: true,
      env: {
        C64_MODE: "vice",
        VICE_TEST_TARGET: "mock",
      },
    });

    assert.equal(parsePlatformStatus(probe.text), "vice");
    assert.deepEqual(parseAvailableBackends(probe.text), [
      { backend: "vice", active: true },
      { backend: "c64u", active: false },
    ]);
    assert.match(probe.text, /c64_select_backend/);
    assert.equal(probe.eventPlatform, "vice");
  });

  await t.test("startup does not wait for RAG warmup before serving requests", async () => {
    const server = await startViceMockServer({ host: "127.0.0.1", port: 0 });
    t.after(async () => {
      await server.stop();
    });

    const startedAt = Date.now();
    await withServerConfig(
      {
        vice: {
          host: "127.0.0.1",
          port: server.port,
        },
      },
      {
        VICE_TEST_TARGET: "mock",
        RAG_INIT_DELAY_MS: "2500",
      },
      async ({ client, diagnosticsDir }) => {
        const startupMs = Date.now() - startedAt;
        assert.ok(
          startupMs < STARTUP_ASSERTION_MS,
          `expected startup under ${STARTUP_ASSERTION_MS}ms, got ${startupMs}ms`,
        );

        const resource = await client.request(
          { method: "resources/read", params: { uri: PLATFORM_RESOURCE_URI } },
          ReadResourceResultSchema,
        );
        const text = resource.contents?.[0]?.text ?? "";

        assert.equal(parsePlatformStatus(text), "vice");

        const complete = await waitForDiagnosticEvent(diagnosticsDir, "rag_init_complete");
        assert.ok(complete.ts);
      },
    );
  });
});
