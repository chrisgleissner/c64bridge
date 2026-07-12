#!/usr/bin/env node
import "./bootstrap/stdio-logger.js";
import { createServer } from "node:http";
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
import { toolRegistry } from "./tools/registry/index.js";
import { unknownErrorResult } from "./tools/errors.js";
import type { ToolRunResult } from "./tools/types.js";
import { createPromptRegistry, type PromptSegment } from "./prompts/registry.js";
import { describePlatformCapabilities, getPlatformStatus, setPlatform } from "./platform.js";
import axios, { type AxiosResponse } from "axios";
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

function parseCliOptions(argv: string[]): CliOptions {
  const httpIndex = argv.indexOf("--http");
  if (httpIndex === -1) {
    return { mode: "stdio" };
  }
  const portCandidate = argv[httpIndex + 1];
  return { mode: "http", port: parsePort(portCandidate) };
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
  });
  
  // Initialize C64 client (reuse existing)
  const client = await withDiagnosticSpan("startup", "create_client", { baseUrl }, async () => new C64Client(baseUrl, {
    networkPassword: config.networkPassword,
    forceC64uFacade: false,
  }));
  const initialBackendType = await withDiagnosticSpan("startup", "resolve_active_backend", {}, () => client.getActiveBackendType());
  setPlatform(initialBackendType);
  writeDiagnosticEvent("platform_initialised", { platform: initialBackendType });
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

  // Create MCP server
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
              text: renderPlatformStatusMarkdown(client),
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
      throw error;
    }
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  writeDiagnosticEvent("mcp_transport_connected", { mode: "stdio" });

  await logConnectivity(client, baseUrl);
  
  console.error("c64bridge MCP server running on stdio");
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

function renderPlatformStatusMarkdown(client: C64Client): string {
  const status = getPlatformStatus();
  const availableBackends = client.getAvailableBackends();
  const capabilities = describePlatformCapabilities(toolRegistry.list());

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
    lines.push("");
  }

  lines.push(
    "> Use `c64_select_backend` to switch to another available backend without restarting the MCP server.",
  );

  return lines.join("\n");
}

async function logConnectivity(client: C64Client, baseUrl: string): Promise<void> {
  const backendType = await client.getBackendType();
  if (backendType !== "c64u") {
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
  const infoUrl = new URL("/v1/info", baseUrl).toString();
  let response: AxiosResponse | null = null;

  try {
    const probeResponse = await axios.get(infoUrl, { timeout: 2000 });
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

function toCallToolResult(result: ToolRunResult): {
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
  } = { content: result.content };

  if (result.structuredContent !== undefined) {
    base.structuredContent = result.structuredContent;
  }
  if (result.metadata !== undefined) {
    base.metadata = result.metadata;
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

main().catch((error) => {
  writeDiagnosticEvent("server_fatal", {
    diagnosticsFile: getDiagnosticsSessionInfo()?.filePath,
    error,
  });
  console.error("Fatal error in MCP server:", error);
  process.exit(1);
});
