import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
const registerAfterAll = typeof globalThis.Bun !== "undefined"
  ? (await import("bun:test")).afterAll
  : (await import("node:test")).after;
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResultSchema, ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { startMockC64Server } from "../../scripts/mockC64Server.mjs";
import { startViceMockServer } from "../../src/vice/mockServer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const PLATFORM_RESOURCE_URI = "c64://platform/status";
const MAX_STDERR_CHARS = 16_384;
const tsLoader = "tsx/esm";

function formatTransportError(error) {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function parsePlatformStatusText(text) {
  const match = String(text ?? "").match(/Current platform:\s*`([^`]+)`/i);
  if (!match) {
    return null;
  }
  const candidate = match[1].trim().toLowerCase();
  return candidate === "vice" || candidate === "c64u" ? candidate : null;
}

function resolveNodeExecutable() {
  const candidates = [
    process.env.C64BRIDGE_TEST_NODE_BIN,
    process.env.C64BRIDGE_NODE_BIN,
    process.env.NODE_BINARY,
    process.env.NODE_EXEC_PATH,
    process.env.npm_node_execpath,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  if (typeof globalThis.Bun !== "undefined") {
    try {
      const which = globalThis.Bun.which?.("node");
      if (which) {
        return which;
      }
    } catch {
      // ignore lookup errors; fall back to plain "node"
    }
    return "node";
  }

  return process.execPath;
}

function resolveBunExecutable() {
  if (typeof globalThis.Bun !== "undefined") {
    return process.execPath;
  }

  const candidates = [
    process.env.C64BRIDGE_TEST_BUN_BIN,
    process.env.C64BRIDGE_BUN_BIN,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "bun";
}

function hasConfiguredBunExecutable(env = process.env) {
  const candidates = [
    env?.C64BRIDGE_TEST_BUN_BIN,
    env?.C64BRIDGE_BUN_BIN,
    process.env.C64BRIDGE_TEST_BUN_BIN,
    process.env.C64BRIDGE_BUN_BIN,
  ];

  return candidates.some((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
}

let sharedSetupPromise;
let executionQueue = Promise.resolve();
let cleanupRegistered = false;
let pendingUsers = 0;
let activeSuites = 0;
let shutdownInFlight;

export function shouldStartViceMockServer(env = process.env) {
  const viceMockFlag = String(env.C64_TEST_ENABLE_VICE_MOCK ?? "").trim().toLowerCase();
  if (viceMockFlag === "true" || viceMockFlag === "1") {
    return true;
  }
  if (viceMockFlag === "false" || viceMockFlag === "0") {
    return false;
  }
  const platform = String(env.C64_MODE ?? "").trim().toLowerCase();
  const viceTarget = String(env.VICE_TEST_TARGET ?? "").trim().toLowerCase();
  return platform === "vice" && viceTarget !== "vice";
}

function appendTail(existing, chunk, maxChars = MAX_STDERR_CHARS) {
  const next = `${existing}${chunk}`;
  return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}

async function setupSharedServer() {
  const mockServer = await startMockC64Server();
  const shouldStartViceMock = shouldStartViceMockServer(process.env);
  const viceMockServer = shouldStartViceMock
    ? await startViceMockServer({ host: "127.0.0.1" })
    : null;

  const useBunRunner = shouldUseBunServerRuntime(process.env);
  const serverEntrypointTs = path.join(repoRoot, "src", "mcp-server.ts");
  const nodeExecutable = resolveNodeExecutable();
  const bunExecutable = resolveBunExecutable();

  const configPath = path.join(
    os.tmpdir(),
    `c64bridge-test-config-${process.pid}-${Date.now()}.json`,
  );
  const mockUrl = new URL(mockServer.baseUrl);
  const configPayload = {
    c64u: {
      host: mockUrl.hostname,
      port: mockUrl.port ? Number(mockUrl.port) : 80,
    },
  };
  if (viceMockServer) {
    configPayload.vice = {
      host: "127.0.0.1",
      port: viceMockServer.port,
    };
  }
  fs.writeFileSync(configPath, JSON.stringify(configPayload), "utf8");

  const childEnv = {
    ...process.env,
    NODE_ENV: "test",
    C64BRIDGE_CONFIG: configPath,
    C64_TEST_TARGET: "mock",
  };
  // When a vice mock server is provisioned, force the child process onto it.
  if (viceMockServer) {
    childEnv.VICE_TEST_TARGET = "mock";
  }

  const transport = new StdioClientTransport({
    command: useBunRunner ? bunExecutable : nodeExecutable,
    args: useBunRunner
      ? [serverEntrypointTs]
      : ["--import", tsLoader, serverEntrypointTs],
    cwd: repoRoot,
    env: childEnv,
    stderr: "pipe",
  });

  const client = new Client(
    { name: "c64bridge-tests", version: "0.0.0" },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
    },
  );

  try {
    let stderrTail = "";
    const stderr = transport.stderr;
    transport.onerror = (error) => {
      stderrTail = appendTail(stderrTail, `[transport error] ${formatTransportError(error)}\n`);
    };
    if (stderr) {
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk) => {
        stderrTail = appendTail(stderrTail, chunk);
      });
      stderr.on("error", (error) => {
        stderrTail = appendTail(stderrTail, `[stderr error] ${formatTransportError(error)}\n`);
      });
    }

    let resolveClose;
    const closePromise = new Promise((resolve) => {
      resolveClose = resolve;
    });

    const previousOnClose = client.onclose;
    client.onclose = () => {
      previousOnClose?.();
      resolveClose?.();
    };

    await client.connect(transport);

    const childProcess = transport._process;
    childProcess?.stdin?.on("error", (error) => {
      stderrTail = appendTail(stderrTail, `[stdin error] ${formatTransportError(error)}\n`);
    });
    childProcess?.stdout?.on("error", (error) => {
      stderrTail = appendTail(stderrTail, `[stdout error] ${formatTransportError(error)}\n`);
    });
    childProcess?.stderr?.on("error", (error) => {
      stderrTail = appendTail(stderrTail, `[child stderr error] ${formatTransportError(error)}\n`);
    });

    const toolSupport = new Map();
    const configuredPlatform = (process.env.C64_MODE ?? "").toLowerCase() === "vice" ? "vice" : "c64u";
    let activePlatform = configuredPlatform;

    try {
      const toolList = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
      for (const descriptor of toolList.tools ?? []) {
        const rawPlatforms = Array.isArray(descriptor._meta?.platforms) && descriptor._meta.platforms.length > 0
          ? descriptor._meta.platforms
          : ["c64u"];
        const unique = Array.from(new Set(rawPlatforms.map((value) => String(value).toLowerCase())));
        toolSupport.set(descriptor.name, Object.freeze(unique));
      }
    } catch {
      // Ignore discovery errors; default behaviour assumes c64u-only tools when metadata is unavailable.
    }

    try {
      const resource = await client.request(
        { method: "resources/read", params: { uri: PLATFORM_RESOURCE_URI } },
        ReadResourceResultSchema,
      );
      activePlatform = parsePlatformStatusText(resource.contents?.[0]?.text ?? "") ?? configuredPlatform;
    } catch {
      // Resource fetch is best-effort; fall back to environment when unavailable.
    }

    async function getPlatform() {
      try {
        const resource = await client.request(
          { method: "resources/read", params: { uri: PLATFORM_RESOURCE_URI } },
          ReadResourceResultSchema,
        );
        return parsePlatformStatusText(resource.contents?.[0]?.text ?? "") ?? activePlatform;
      } catch {
        return activePlatform;
      }
    }

    let shutdownStarted = false;
    async function shutdown({ force = false } = {}) {
      if (shutdownStarted) {
        return;
      }
      shutdownStarted = true;
      try {
        await client.close();
        await closePromise;
      } catch (error) {
        if (force && transport.pid) {
          try {
            process.kill(transport.pid, "SIGKILL");
          } catch {
            // ignore kill failures
          }
        }
      } finally {
        fs.rmSync(configPath, { force: true });
        await mockServer.close();
        if (viceMockServer) {
          await viceMockServer.stop();
        }
      }
    }

    function stderrOutput() {
      if (stderrTail.length === 0) {
        return "";
      }
      const output = stderrTail;
      stderrTail = "";
      return output;
    }

    return {
      client,
      transport,
      mockServer,
      stderrOutput,
      shutdown,
      platform: activePlatform,
      getPlatform,
      toolSupport,
      isToolSupported(toolName, targetPlatform = activePlatform) {
        const normalizedPlatform = targetPlatform === "vice" ? "vice" : "c64u";
        const supported = toolSupport.get(toolName);
        if (!supported || supported.length === 0) {
          return normalizedPlatform === "c64u";
        }
        return supported.includes(normalizedPlatform);
      },
    };
  } catch (error) {
    try {
      await mockServer.close();
    } catch {}
    if (viceMockServer) {
      try {
        await viceMockServer.stop();
      } catch {}
    }
    try {
      fs.rmSync(configPath, { force: true });
    } catch {}
    if (transport?.pid) {
      try {
        process.kill(transport.pid, "SIGKILL");
      } catch {}
    }
    throw error;
  }
}

export function shouldUseBunServerRuntime(env = process.env) {
  const requested = String(env?.C64BRIDGE_TEST_MCP_SERVER_RUNTIME ?? process.env.C64BRIDGE_TEST_MCP_SERVER_RUNTIME ?? "").trim().toLowerCase();
  if (requested === "node") {
    return false;
  }
  if (requested === "bun") {
    return true;
  }
  return typeof globalThis.Bun !== "undefined" || hasConfiguredBunExecutable(env);
}

function isConnected(harness) {
  return Boolean(harness?.client?.transport && harness.transport?.pid);
}

function scheduleShutdown() {
  if (shutdownInFlight || pendingUsers > 0 || activeSuites > 0 || !sharedSetupPromise) {
    return;
  }

  shutdownInFlight = sharedSetupPromise
    .then(async (harness) => {
      await harness.shutdown({ force: true });
    })
    .catch(() => {})
    .finally(() => {
      shutdownInFlight = undefined;
      sharedSetupPromise = undefined;
    });
}

async function ensureHarness() {
  if (!sharedSetupPromise) {
    sharedSetupPromise = setupSharedServer();
  }

  let harness = await sharedSetupPromise;
  if (!isConnected(harness)) {
    try {
      await harness.shutdown({ force: true });
    } catch {
      // ignore forced shutdown errors when recovering
    }
    sharedSetupPromise = setupSharedServer();
    harness = await sharedSetupPromise;
  }
  return harness;
}

export function withSharedMcpClient(callback) {
  pendingUsers += 1;

  const current = executionQueue.then(async () => {
    const harness = await ensureHarness();
    harness.mockServer.reset?.();
    const platform = typeof harness.getPlatform === "function"
      ? await harness.getPlatform()
      : harness.platform;
    try {
      return await callback({
        client: harness.client,
        mockServer: harness.mockServer,
        stderrOutput: harness.stderrOutput,
        platform,
        isToolSupported(toolName) {
          return harness.isToolSupported(toolName, platform);
        },
      });
    } finally {
      const logs = harness.stderrOutput();
      if (logs) {
        process.stderr.write(logs);
      }
      harness.mockServer.reset?.();
    }
  });

  executionQueue = current.catch(() => {});
  return current.finally(() => {
    pendingUsers = Math.max(0, pendingUsers - 1);
    if (pendingUsers === 0 && activeSuites === 0) {
      scheduleShutdown();
    }
  });
}

export function registerHarnessSuite(id = import.meta?.url ?? `suite-${Date.now()}`) {
  activeSuites += 1;

registerAfterAll(() => {
    activeSuites = Math.max(0, activeSuites - 1);
    if (pendingUsers === 0 && activeSuites === 0) {
      scheduleShutdown();
    }
  });

  return id;
}

function registerProcessCleanup() {
  const shutdown = () => {
    if (!sharedSetupPromise) {
      return;
    }
    activeSuites = 0;
    sharedSetupPromise
      .then((harness) => harness.shutdown({ force: true }))
      .catch(() => {
        // ignore cleanup failures to avoid masking test errors
      })
      .finally(() => {
        sharedSetupPromise = undefined;
      });
  };

  process.once("exit", shutdown);
  process.once("SIGINT", () => {
    shutdown();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    shutdown();
    process.exit(143);
  });
}

if (!cleanupRegistered) {
  cleanupRegistered = true;
  registerProcessCleanup();
}
