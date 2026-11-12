#!/usr/bin/env node
import "./bootstrap/stdio-logger.js";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { C64Client } from "./c64Client.js";
import {
  listKnowledgeResources,
  readKnowledgeResource,
} from "./rag/knowledgeIndex.js";
import { PLATFORM_RESOURCE_URI } from "./rag/resourceUris.js";
import { createLazyRagRetriever, initRag } from "./rag/init.js";
import type { RagRetriever } from "./rag/types.js";
import { getMcpServerImplementationInfo } from "./mcp/metadata.js";
import { stopAllBackgroundTasks } from "./tools/meta/background.js";
import { delegateViceSignalHandling, stopManagedViceProcessesSync } from "./device.js";
import { toolRegistry } from "./tools/registry/index.js";
import { ToolValidationError, unknownErrorResult } from "./tools/errors.js";
import type { ToolRunResult } from "./tools/types.js";
import { createPromptRegistry, type PromptSegment } from "./prompts/registry.js";
import { describePlatformCapabilities, getPlatformStatus, setPlatform } from "./platform.js";
import axios, { type AxiosResponse } from "axios";
import { redactValue, registerSecret } from "./redact.js";
import { loggerFor, payloadByteLength, formatPayloadForDebug, formatErrorMessage } from "./logger.js";
import { getDiagnosticsSessionInfo, installProcessDiagnostics, withDiagnosticSpan, writeDiagnosticEvent } from "./diagnostics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

type CliOptions = { mode: "stdio" } | { mode: "http"; port?: number };

interface ServerRuntimeContext {
  client: C64Client;
  rag: RagRetriever;
  baseUrl: string;
}

function createPromptRegistryGetter() {
  let registry: ReturnType<typeof createPromptRegistry> | undefined;
  return () => {
    if (!registry) {
      writeDiagnosticEvent("prompt_registry_init_start");
      registry = createPromptRegistry();
      writeDiagnosticEvent("prompt_registry_init_complete");
    }
    return registry;
  };
}

export function parseCliOptions(argv: string[]): CliOptions {
  const httpIndex = argv.indexOf("--http");
  if (httpIndex === -1) {
    return { mode: "stdio" };
  }
  const portCandidate = argv[httpIndex + 1];
  return { mode: "http", port: parsePort(portCandidate) };
}

/**
 * DNS-rebinding and cross-origin protection for the HTTP transport. Returns
 * the rejection (status and message) or null when the request may proceed.
 * Host must be a loopback name with the listening port, any Origin must be a
 * loopback http origin on that port, and when a token is configured the
 * request must carry the matching bearer token.
 */
export function checkHttpRequestAccess(
  headers: IncomingHttpHeaders,
  port: number,
  token?: string,
): { status: number; message: string } | null {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const host = headers.host?.toLowerCase();
  if (!host || !allowedHosts.includes(host)) {
    return { status: 403, message: "Forbidden: invalid Host header" };
  }
  const origin = headers.origin;
  if (origin !== undefined) {
    const allowedOrigins = allowedHosts.map((entry) => `http://${entry}`);
    if (typeof origin !== "string" || !allowedOrigins.includes(origin.toLowerCase())) {
      return { status: 403, message: "Forbidden: invalid Origin header" };
    }
  }
  if (token) {
    const header = headers.authorization;
    const presented = typeof header === "string" && /^Bearer /i.test(header) ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(token, "utf8");
    const presentedBuffer = Buffer.from(presented, "utf8");
    if (presentedBuffer.length !== expectedBuffer.length || !timingSafeEqual(presentedBuffer, expectedBuffer)) {
      return { status: 401, message: "Unauthorized" };
    }
  }
  return null;
}

const SHUTDOWN_CLEANUP_TIMEOUT_MS = 2_000;

/**
 * Installs the single shutdown path. The first trigger stops background
 * tasks, releases any capture session and stops managed VICE processes, then
 * exits. Later triggers return the same promise. Stdin end/close is a
 * trigger only in stdio mode (the client went away).
 */
function installShutdown(client: C64Client, mode: "stdio" | "http"): void {
  delegateViceSignalHandling();
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (reason: string, exitCode: number): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    writeDiagnosticEvent("server_shutdown", { reason });
    console.error(`c64bridge shutting down (${reason})`);
    shutdownPromise = (async () => {
      try {
        const cleanup = Promise.allSettled([
          stopAllBackgroundTasks(),
          client.releaseVideoCapture(),
        ]);
        await Promise.race([
          cleanup,
          new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_CLEANUP_TIMEOUT_MS).unref()),
        ]);
      } catch {
        // Cleanup is best effort; always continue to exit.
      }
      try {
        stopManagedViceProcessesSync();
      } catch {
        // ignore
      }
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM", 143));
  process.on("SIGINT", () => void shutdown("SIGINT", 130));
  process.on("SIGHUP", () => void shutdown("SIGHUP", 129));
  if (mode === "stdio") {
    process.stdin.once("end", () => void shutdown("stdin end", 0));
    process.stdin.once("close", () => void shutdown("stdin close", 0));
  }
}

function parsePort(raw?: string): number | undefined {
  if (!raw || raw.startsWith("--")) {
    return undefined;
  }
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
    return parsed;
  }
  return undefined;
}

async function main() {
  const diagnostics = installProcessDiagnostics("mcp-server");
  console.error("Starting c64bridge MCP server...");
  console.error(`c64bridge diagnostics file: ${diagnostics.filePath}`);
  writeDiagnosticEvent("server_start", { diagnosticsFile: diagnostics.filePath });

  const config = await withDiagnosticSpan("startup", "load_config", {}, () => Promise.resolve(loadConfig()));
  const baseUrl = config.baseUrl ?? `http://${config.c64_host}`;
  writeDiagnosticEvent("config_loaded", {
    baseUrl,
    hasNetworkPassword: Boolean(config.networkPassword),
    vicePrewarm: config.vicePrewarm,
  });
  
  // Initialize C64 client (reuse existing)
  const client = await withDiagnosticSpan("startup", "create_client", { baseUrl }, async () => new C64Client(baseUrl, {
    networkPassword: config.networkPassword,
    forceC64uFacade: false,
  }));
  const initialBackendType = await withDiagnosticSpan("startup", "resolve_active_backend", {}, () => client.getActiveBackendType());
  setPlatform(initialBackendType);
  writeDiagnosticEvent("platform_initialised", { platform: initialBackendType });
  if (config.vicePrewarm) {
    const availableBackends = client.getAvailableBackends();
    if (availableBackends.includes("vice")) {
      writeDiagnosticEvent("vice_prewarm_start");
      void client.prewarmBackends(["vice"])
        .then((result) => {
          writeDiagnosticEvent("vice_prewarm_complete", { result });
        })
        .catch((error) => {
          writeDiagnosticEvent("vice_prewarm_failed", { error });
        });
    } else {
      writeDiagnosticEvent("vice_prewarm_skipped", { reason: "vice_not_configured" });
    }
  }
  const rag: RagRetriever = createLazyRagRetriever(() => initRag(), {
    onInitStart() {
      writeDiagnosticEvent("rag_init_start");
    },
    onInitComplete() {
      writeDiagnosticEvent("rag_init_complete");
    },
    onInitError(error) {
      writeDiagnosticEvent("rag_init_failed", { error });
    },
  });
  void (rag as { warmup?: () => Promise<void> }).warmup?.().catch(() => {
    // Diagnostics already record the failure; keep startup non-blocking.
  });

  const toolLogger = loggerFor("tool");
  const resourceLogger = loggerFor("resource");
  const promptLogger = loggerFor("prompt");
  const promptRegistry = createPromptRegistry();
  const getPromptRegistry = createPromptRegistryGetter();
  const implementationInfo = getMcpServerImplementationInfo();

  // Create MCP server. Stateless HTTP mode needs a fresh Server and transport
  // per request (the SDK rejects reuse of a stateless transport), so server
  // creation and handler registration live in this factory. The handler bodies
  // below are unchanged and intentionally not re-indented.
  const createMcpServer = (): Server => {
  const server = new Server(
    implementationInfo,
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
    }
  );

  // RESOURCES: Expose C64 knowledge base
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const startedAt = Date.now();
    writeDiagnosticEvent("mcp_list_resources_start");
    try {
      const knowledgeResources = listKnowledgeResources().map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
        _meta: resource.metadata,
      }));

      const platformResource = createPlatformResourceDescriptor();

      const response = {
        resources: [...knowledgeResources, platformResource],
      };

      const latency = Date.now() - startedAt;
      const bytes = payloadByteLength(response);
      resourceLogger.info(`list resources count=${response.resources.length} bytes=${bytes} latencyMs=${latency}`);

      if (resourceLogger.isDebugEnabled()) {
        resourceLogger.debug("list resources request", { request: {} });
        resourceLogger.debug("list resources response", { response: formatPayloadForDebug(response) });
      }

      writeDiagnosticEvent("mcp_list_resources_ok", {
        count: response.resources.length,
        latencyMs: latency,
      });

      return response;
    } catch (error) {
      const latency = Date.now() - startedAt;
      resourceLogger.error(`list resources failed bytes=0 latencyMs=${latency} error=${formatErrorMessage(error)}`);
      if (resourceLogger.isDebugEnabled()) {
        resourceLogger.debug("list resources request", { request: {} });
        resourceLogger.debug("list resources error", { error: formatErrorMessage(error) });
      }
      writeDiagnosticEvent("mcp_list_resources_failed", { latencyMs: latency, error });
      throw error;
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const startedAt = Date.now();
    writeDiagnosticEvent("mcp_read_resource_start", { uri: request.params.uri });
    try {
      let response;
      if (request.params.uri === PLATFORM_RESOURCE_URI) {
        response = {
          contents: [
            {
              uri: PLATFORM_RESOURCE_URI,
              mimeType: "text/markdown",
              text: await renderPlatformStatusMarkdown(client),
            },
          ],
        };
      } else {
        const result = readKnowledgeResource(request.params.uri, PROJECT_ROOT);
        if (!result) {
          throw new Error(`Unknown resource: ${request.params.uri}`);
        }
        response = {
          contents: [result],
        };
      }

      const latency = Date.now() - startedAt;
      const bytes = payloadByteLength(response);
      resourceLogger.info(`read resource uri=${request.params.uri} bytes=${bytes} latencyMs=${latency}`);

      if (resourceLogger.isDebugEnabled()) {
        resourceLogger.debug("read resource request", { request: formatPayloadForDebug(request.params) });
        resourceLogger.debug("read resource response", { response: formatPayloadForDebug(response) });
      }

      writeDiagnosticEvent("mcp_read_resource_ok", {
        uri: request.params.uri,
        latencyMs: latency,
      });

      return response;
    } catch (error) {
      const latency = Date.now() - startedAt;
      resourceLogger.error(`read resource uri=${request.params.uri} bytes=0 latencyMs=${latency} error=${formatErrorMessage(error)}`);
      if (resourceLogger.isDebugEnabled()) {
        resourceLogger.debug("read resource request", { request: formatPayloadForDebug(request.params) });
        resourceLogger.debug("read resource error", { error: formatErrorMessage(error) });
      }
      writeDiagnosticEvent("mcp_read_resource_failed", {
        uri: request.params.uri,
        latencyMs: latency,
        error,
      });
      throw error;
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const startedAt = Date.now();
    writeDiagnosticEvent("mcp_list_tools_start");
    try {
      const response = {
        tools: toolRegistry.list().map((tool) => ({
          name: tool.name,
          title: tool.metadata.summary,
          description: tool.description,
          inputSchema: tool.inputSchema,
          _meta: tool.metadata,
        })),
      };
      const latency = Date.now() - startedAt;
      const bytes = payloadByteLength(response);
      toolLogger.info(`list tools count=${response.tools.length} bytes=${bytes} latencyMs=${latency}`);

      if (toolLogger.isDebugEnabled()) {
        toolLogger.debug("list tools request", { request: {} });
        toolLogger.debug("list tools response", { response: formatPayloadForDebug(response) });
      }

      writeDiagnosticEvent("mcp_list_tools_ok", {
        count: response.tools.length,
        latencyMs: latency,
      });

      return response;
    } catch (error) {
      const latency = Date.now() - startedAt;
      toolLogger.error(`list tools failed bytes=0 latencyMs=${latency} error=${formatErrorMessage(error)}`);
      if (toolLogger.isDebugEnabled()) {
        toolLogger.debug("list tools request", { request: {} });
        toolLogger.debug("list tools error", { error: formatErrorMessage(error) });
      }
      writeDiagnosticEvent("mcp_list_tools_failed", { latencyMs: latency, error });
      throw error;
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const startedAt = Date.now();
    writeDiagnosticEvent("mcp_list_prompts_start");
    try {
      const entries = promptRegistry.list();
      const response = {
        prompts: entries.map((entry) => ({
          name: entry.descriptor.name,
          title: entry.descriptor.title,
          description: entry.descriptor.description,
          arguments: entry.arguments?.map((argument) => ({
            name: argument.name,
            description: argument.description,
            required: argument.required,
            options: argument.options,
          })),
          _meta: {
            requiredResources: entry.descriptor.requiredResources,
            optionalResources: entry.descriptor.optionalResources ?? [],
            tools: entry.descriptor.tools,
            tags: entry.descriptor.tags ?? [],
            argumentOptions: Object.fromEntries(
              (entry.arguments ?? [])
                .filter((argument) => Array.isArray(argument.options) && argument.options.length > 0)
                .map((argument) => [argument.name, argument.options]),
            ),
          },
        })),
      };

      const latency = Date.now() - startedAt;
      const bytes = payloadByteLength(response);
      promptLogger.info(`list prompts count=${response.prompts.length} bytes=${bytes} latencyMs=${latency}`);

      if (promptLogger.isDebugEnabled()) {
        promptLogger.debug("list prompts request", { request: {} });
        promptLogger.debug("list prompts response", { response: formatPayloadForDebug(response) });
      }

      writeDiagnosticEvent("mcp_list_prompts_ok", {
        count: response.prompts.length,
        latencyMs: latency,
      });

      return response;
    } catch (error) {
      const latency = Date.now() - startedAt;
      promptLogger.error(`list prompts failed bytes=0 latencyMs=${latency} error=${formatErrorMessage(error)}`);
      if (promptLogger.isDebugEnabled()) {
        promptLogger.debug("list prompts request", { request: {} });
        promptLogger.debug("list prompts error", { error: formatErrorMessage(error) });
      }
      writeDiagnosticEvent("mcp_list_prompts_failed", { latencyMs: latency, error });
      throw error;
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    const startedAt = Date.now();
    writeDiagnosticEvent("mcp_call_tool_start", {
      name,
      arguments: formatPayloadForDebug(args),
    });
    if (toolLogger.isDebugEnabled()) {
      toolLogger.debug("tool request", {
        name,
        arguments: formatPayloadForDebug(args),
      });
    }

    try {
      const result = await toolRegistry.invoke(name, args, {
        client,
        rag,
        logger: toolLogger,
        platform: getPlatformStatus(),
        setPlatform,
      });

      const response = toCallToolResult(result);
      const latency = Date.now() - startedAt;
      const bytes = payloadByteLength(response);
      const status = result.isError ? "error" : "ok";

      toolLogger.info(`call tool name=${name} status=${status} bytes=${bytes} latencyMs=${latency}`);

      if (toolLogger.isDebugEnabled()) {
        toolLogger.debug("tool response", {
          name,
          response: formatPayloadForDebug(response),
        });
      }

      writeDiagnosticEvent("mcp_call_tool_ok", {
        name,
        latencyMs: latency,
        isError: result.isError === true,
      });

      return response;
    } catch (error) {
      const latency = Date.now() - startedAt;
      const fallback = unknownErrorResult(error);
      const response = toCallToolResult(fallback);
      const bytes = payloadByteLength(response);

      toolLogger.error(`call tool name=${name} status=failed bytes=${bytes} latencyMs=${latency} error=${formatErrorMessage(error)}`);

      if (toolLogger.isDebugEnabled()) {
        toolLogger.debug("tool response", {
          name,
          response: formatPayloadForDebug(response),
          error: formatErrorMessage(error),
        });
      }

      writeDiagnosticEvent("mcp_call_tool_failed", {
        name,
        latencyMs: latency,
        error,
      });

      return response;
    }
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    const startedAt = Date.now();
    writeDiagnosticEvent("mcp_get_prompt_start", {
      name,
      arguments: formatPayloadForDebug(args),
    });

    if (promptLogger.isDebugEnabled()) {
      promptLogger.debug("prompt request", {
        name,
        arguments: formatPayloadForDebug(args),
      });
    }

    try {
      const resolved = promptRegistry.resolve(name, args);

      const response = {
        description: resolved.description,
        messages: resolved.messages.map(toPromptMessage),
        _meta: {
          arguments: resolved.arguments,
          resources: resolved.resources.map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            description: resource.description,
            mimeType: resource.mimeType,
            metadata: resource.metadata,
          })),
          tools: resolved.tools,
        },
      };

      const latency = Date.now() - startedAt;
      const bytes = payloadByteLength(response);
      promptLogger.info(`get prompt name=${name} bytes=${bytes} latencyMs=${latency}`);

      if (promptLogger.isDebugEnabled()) {
        promptLogger.debug("prompt response", {
          name,
          response: formatPayloadForDebug(response),
        });
      }

      writeDiagnosticEvent("mcp_get_prompt_ok", {
        name,
        latencyMs: latency,
      });

      return response;
    } catch (error) {
      const latency = Date.now() - startedAt;
      promptLogger.error(`get prompt name=${name} bytes=0 latencyMs=${latency} error=${formatErrorMessage(error)}`);
      if (promptLogger.isDebugEnabled()) {
        promptLogger.debug("prompt request", {
          name,
          arguments: formatPayloadForDebug(args),
        });
        promptLogger.debug("prompt error", { name, error: formatErrorMessage(error) });
      }
      writeDiagnosticEvent("mcp_get_prompt_failed", {
        name,
        latencyMs: latency,
        error,
      });
      if (error instanceof ToolValidationError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }
  });

  return server;
  };

  const cli = parseCliOptions(process.argv.slice(2));
  if (cli.mode === "http") {
    const port = cli.port ?? 3000;
    const httpToken = process.env.C64BRIDGE_HTTP_TOKEN || undefined;
    if (httpToken) {
      registerSecret(httpToken);
    }
    const httpServer = createServer((request, response) => {
      const rejection = checkHttpRequestAccess(request.headers, port, httpToken);
      if (rejection) {
        response.statusCode = rejection.status;
        if (rejection.status === 401) response.setHeader("WWW-Authenticate", "Bearer");
        response.end(rejection.message);
        return;
      }
      if (request.url?.split("?")[0] !== "/mcp") {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      // Stateless mode: one Server and one transport per request.
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.once("close", () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      void server
        .connect(transport)
        .then(() => transport.handleRequest(request, response))
        .catch((error) => {
          if (!response.headersSent) response.statusCode = 500;
          response.end(error instanceof Error ? error.message : "MCP transport error");
        });
    });
    await new Promise<void>((resolve, reject) => httpServer.listen(port, "127.0.0.1", resolve).once("error", reject));
    installShutdown(client, "http");
    writeDiagnosticEvent("mcp_transport_connected", { mode: "http", port });
    console.error(`c64bridge MCP server running on HTTP at http://127.0.0.1:${port}/mcp`);
  } else {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    installShutdown(client, "stdio");
    writeDiagnosticEvent("mcp_transport_connected", { mode: "stdio" });
    console.error("c64bridge MCP server running on stdio");
  }

  await logConnectivity(client, baseUrl, config.networkPassword);
  
  writeDiagnosticEvent("server_ready", {
    diagnosticsFile: diagnostics.filePath,
  });
}

function createPlatformResourceDescriptor() {
  return {
    uri: PLATFORM_RESOURCE_URI,
    name: "Active Platform Status",
    description: "Reports the active MCP platform and tool compatibility snapshot.",
    mimeType: "text/markdown",
    _meta: {
      domain: "platform",
      priority: "critical",
      summary: "Current platform (c64u or vice), feature flags, and tool support overview.",
      prompts: [],
      tools: [],
      tags: ["platform", "compatibility"],
      relatedResources: [],
    },
  };
}

export async function renderPlatformStatusMarkdown(client: C64Client): Promise<string> {
  const status = getPlatformStatus();
  const availableBackends = client.getAvailableBackends();
  const capabilities = describePlatformCapabilities(toolRegistry.list());
  // Resource reads must remain responsive while an Ultimate boots or is
  // unreachable. The probe itself remains retryable (unknown is not cached).
  const nativeEndpoints = await Promise.race([
    client.getNativeEndpointCapabilities(),
    new Promise<Awaited<ReturnType<C64Client["getNativeEndpointCapabilities"]>>>((resolve) => {
      setTimeout(() => resolve({ machineInput: "unknown", machineMenuScreen: "unknown" }), 750).unref();
    }),
  ]);

  const lines: string[] = [
    "# MCP Platform Status",
    "",
    `Current platform: \`${status.id}\``,
    "",
    "## Available Backends",
    "",
    ...availableBackends.map((backend) => `- \`${backend}\`${backend === status.id ? " (active)" : ""}`),
    "",
    status.features.length > 0
      ? ["## Active Features", "", ...status.features.map((feature) => `- ${feature}`)].join("\n")
      : "",
    status.limitedFeatures.length > 0
      ? ["## Limited or Unavailable Features", "", ...status.limitedFeatures.map((feature) => `- ${feature}`)].join("\n")
      : "",
    "## Native REST Endpoint Availability",
    "",
    `- \`machine:input\`: **${nativeEndpoints.machineInput}**`,
    `- \`machine:menu_screen\`: **${nativeEndpoints.machineMenuScreen}** (it can only be confirmed while an Ultimate menu is visible)`,
    "",
    "Use physical-input, menu-screen, and C64U/U64 Tool Menu power-cycle operations only when the required endpoint is available. Prefer `key` or `write_text` for ordinary C64 input when `machine:input` is unavailable.",
    "",
    "## Tool Compatibility",
    "",
  ].filter(Boolean);

  for (const [platformId, info] of Object.entries(capabilities.platforms)) {
    lines.push(`### ${platformId.toUpperCase()}`);
    lines.push("");
    lines.push(
      info.tools.length > 0
        ? `- Supported tools (${info.tools.length}): ${info.tools.map((tool) => `\`${tool}\``).join(", ")}`
        : "- Supported tools: _none_",
    );
    lines.push(
      info.unsupported_tools.length > 0
        ? `- Unsupported tools (${info.unsupported_tools.length}): ${info.unsupported_tools
            .map((tool) => `\`${tool}\``)
            .join(", ")}`
        : "- Unsupported tools: _none_",
    );
    lines.push(
      info.unsupported_operations.length > 0
        ? `- Unsupported operations of supported tools (${info.unsupported_operations.length}): ${info.unsupported_operations
            .map((operation) => `\`${operation}\``)
            .join(", ")}`
        : "- Unsupported operations of supported tools: _none_",
    );
    lines.push("");
  }

  lines.push(
    "> Use `c64_select_backend` to switch to another available backend without restarting the MCP server.",
  );

  return lines.join("\n");
}

/** URL of the Ultimate's /v1/info route, keeping any path prefix of the base URL (reverse proxy). */
export function connectivityProbeUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/info`;
}

async function logConnectivity(client: C64Client, baseUrl: string, networkPassword?: string): Promise<void> {
  const backendType = await client.getBackendType();
  if (backendType === "vice") {
    writeDiagnosticEvent("connectivity_probe_skipped", { baseUrl, reason: "vice_backend" });
    console.error("Skipping direct REST connectivity probe because active backend is VICE");
    try {
      const memoryAddress = "$0000";
      const memoryResult = await client.readMemory(memoryAddress, "1");
      if (memoryResult.success && memoryResult.data) {
        writeDiagnosticEvent("zero_page_probe_ok", { address: memoryAddress, data: memoryResult.data, backendType });
        console.error(`VICE zero-page probe @ ${memoryAddress}: ${memoryResult.data}`);
      } else if (memoryResult.details) {
        writeDiagnosticEvent("zero_page_probe_failed", { address: memoryAddress, details: memoryResult.details, backendType });
        console.error(`VICE zero-page probe failed: ${JSON.stringify(memoryResult.details)}`);
      }
    } catch (memoryError) {
      const message = memoryError instanceof Error ? memoryError.message : String(memoryError);
      writeDiagnosticEvent("zero_page_probe_failed", { address: "$0000", error: memoryError, backendType });
      console.error(`VICE zero-page probe skipped or failed: ${message}`);
    }
    return;
  }

  const c64Logger = loggerFor("c64u");
  const startedAt = Date.now();
  const infoUrl = connectivityProbeUrl(baseUrl);
  let response: AxiosResponse | null = null;

  try {
    // Send the network password like every other request, or a protected device answers 403.
    registerSecret(networkPassword);
    const probeResponse = await axios.get(infoUrl, {
      timeout: 2000,
      ...(networkPassword ? { headers: { "X-Password": networkPassword } } : {}),
    });
    response = probeResponse;
    const latency = Date.now() - startedAt;
    const bytes = payloadByteLength(probeResponse.data);
    c64Logger.info(`GET ${infoUrl} status=${probeResponse.status} bytes=${bytes} latencyMs=${latency}`);
  } catch (error) {
    const latency = Date.now() - startedAt;
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? "ERR";
      const bytes = error.response ? payloadByteLength(error.response.data) : 0;
      c64Logger.warn(`GET ${infoUrl} status=${status} bytes=${bytes} latencyMs=${latency} error=${formatErrorMessage(error)}`);
    } else {
      c64Logger.error(`GET ${infoUrl} status=ERR bytes=0 latencyMs=${latency} error=${formatErrorMessage(error)}`);
    }
    writeDiagnosticEvent("connectivity_probe_skipped", { baseUrl, latencyMs: latency, error });
    console.error(`Skipping direct REST connectivity probe (no hardware REST base reachable at ${baseUrl})`);
    return;
  }

  if (!response) {
    writeDiagnosticEvent("connectivity_probe_skipped", { baseUrl, reason: "empty_response" });
    console.error(`Skipping direct REST connectivity probe (no hardware REST base reachable at ${baseUrl})`);
    return;
  }

  writeDiagnosticEvent("connectivity_probe_ok", { baseUrl, status: response.status });
  console.error(`Connectivity check succeeded for c64 device at ${baseUrl}`);

  try {
    const memoryAddress = "$0000";
    const memoryResult = await client.readMemory(memoryAddress, "1");
    if (memoryResult.success && memoryResult.data) {
      writeDiagnosticEvent("zero_page_probe_ok", { address: memoryAddress, data: memoryResult.data });
      console.error(`Zero-page probe @ ${memoryAddress}: ${memoryResult.data}`);
    } else if (memoryResult.details) {
      writeDiagnosticEvent("zero_page_probe_failed", { address: memoryAddress, details: memoryResult.details });
      console.error(`Zero-page probe failed: ${JSON.stringify(memoryResult.details)}`);
    }
  } catch (memoryError) {
    const message = memoryError instanceof Error ? memoryError.message : String(memoryError);
    writeDiagnosticEvent("zero_page_probe_failed", { address: "$0000", error: memoryError });
    console.error(`Zero-page probe skipped or failed (may be unsupported on current backend): ${message}`);
  }
}

export function toCallToolResult(result: ToolRunResult): {
  content: ToolRunResult["content"];
  structuredContent?: ToolRunResult["structuredContent"];
  metadata?: ToolRunResult["metadata"];
  isError?: boolean;
} {
  const base: {
    content: ToolRunResult["content"];
    structuredContent?: ToolRunResult["structuredContent"];
    metadata?: ToolRunResult["metadata"];
    isError?: boolean;
  } = { content: redactValue(result.content) as ToolRunResult["content"] };

  if (result.structuredContent !== undefined) {
    base.structuredContent = redactValue(result.structuredContent) as ToolRunResult["structuredContent"];
  }
  if (result.metadata !== undefined) {
    base.metadata = redactValue(result.metadata) as ToolRunResult["metadata"];
  }
  if (result.isError !== undefined) {
    base.isError = result.isError;
  }

  return base;
}

function toPromptMessage(segment: PromptSegment): {
  role: "assistant" | "user";
  content: { type: "text"; text: string };
} {
  const role = segment.role === "user" ? "user" : "assistant";
  return {
    role,
    content: {
      type: "text",
      text: segment.content,
    },
  };
}

// The documented entrypoint (src/index.ts / dist/index.js, per package.json
// "main"/"bin") always imports this module as a side effect rather than
// invoking it as the process's own script, so process.argv[1] never points
// here — an entrypoint-identity check would wrongly skip startup in every
// real deployment. Test code that only needs a pure export (e.g.
// parseCliOptions, renderPlatformStatusMarkdown) sets this opt-out instead,
// mirroring the existing C64BRIDGE_START_SKIP_AUTO_LAUNCH convention in
// scripts/start.mjs.
if (process.env.C64BRIDGE_SKIP_AUTO_START !== "1") {
  main().catch((error) => {
    writeDiagnosticEvent("server_fatal", {
      diagnosticsFile: getDiagnosticsSessionInfo()?.filePath,
      error,
    });
    console.error("Fatal error in MCP server:", redactValue(error));
    process.exit(1);
  });
}
