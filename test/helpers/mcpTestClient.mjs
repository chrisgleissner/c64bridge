import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const registerDataUri = "data:text/javascript,import { register } from \"node:module\"; import { pathToFileURL } from \"node:url\"; register(\"ts-node/esm\", pathToFileURL(\"./\"));";

function formatTransportError(error) {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function isIgnorableSocketTeardownError(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return code === "ECONNRESET" || code === "EPIPE" || text.includes("ECONNRESET") || text.includes("EPIPE");
}

export async function createConnectedClient(options = {}) {
  const useBunRunner = shouldUseBunServerRuntime(options.env);
  const serverEntrypointTs = path.join(repoRoot, "src", "mcp-server.ts");
  const command = useBunRunner ? resolveBunExecutable() : resolveNodeExecutable();
  const args = useBunRunner
    ? [serverEntrypointTs]
    : ["--import", registerDataUri, serverEntrypointTs];

  const transport = new StdioClientTransport({
    command,
    args,
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      ...options.env,
    },
    stderr: "pipe",
  });

  const client = new Client(
    { name: options.clientName ?? "c64bridge-tests", version: options.clientVersion ?? "0.0.0" },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
    },
  );

  const stderrChunks = [];
  const stderr = transport.stderr;
  transport.onerror = (error) => {
    stderrChunks.push(`[transport error] ${formatTransportError(error)}\n`);
  };
  let resolveClose;
  const closePromise = new Promise((resolve) => {
    resolveClose = resolve;
  });
  const previousOnClose = client.onclose;
  client.onclose = () => {
    previousOnClose?.();
    resolveClose?.();
  };
  if (stderr) {
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk) => stderrChunks.push(chunk));
    stderr.on("error", (error) => {
      stderrChunks.push(`[stderr error] ${formatTransportError(error)}\n`);
    });
  }

  await client.connect(transport);

  const childProcess = transport._process;
  childProcess?.stdin?.on("error", (error) => {
    stderrChunks.push(`[stdin error] ${formatTransportError(error)}\n`);
  });
  childProcess?.stdout?.on("error", (error) => {
    stderrChunks.push(`[stdout error] ${formatTransportError(error)}\n`);
  });
  childProcess?.stderr?.on("error", (error) => {
    stderrChunks.push(`[child stderr error] ${formatTransportError(error)}\n`);
  });

  return {
    client,
    stderrOutput: () => stderrChunks.join(""),
    async close() {
      const swallowSocketReset = (error) => {
        if (isIgnorableSocketTeardownError(error)) {
          stderrChunks.push(`[shutdown ignore] ${formatTransportError(error)}\n`);
          return;
        }
        throw error;
      };
      process.prependListener("uncaughtException", swallowSocketReset);
      try {
        await client.close();
        await closePromise;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        process.removeListener("uncaughtException", swallowSocketReset);
      }
    },
  };
}

function shouldUseBunServerRuntime(env = process.env) {
  const requested = String(env?.C64BRIDGE_TEST_MCP_SERVER_RUNTIME ?? process.env.C64BRIDGE_TEST_MCP_SERVER_RUNTIME ?? "").trim().toLowerCase();
  if (requested === "node") {
    return false;
  }
  if (requested === "bun") {
    return true;
  }
  return true;
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

  return "node";
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

