#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeToolModules, type ToolModuleDescriptor } from "../src/tools/registry/index.js";
import type { JsonSchema, ToolDescriptor } from "../src/tools/types.js";
import { listKnowledgeResources } from "../src/rag/knowledgeIndex.js";
import { createPromptRegistry } from "../src/prompts/registry.js";

const START_MARKER = "<!-- AUTO-GENERATED:MCP-DOCS-START -->";
const END_MARKER = "<!-- AUTO-GENERATED:MCP-DOCS-END -->";
const ENV_START_MARKER = "<!-- AUTO-GENERATED:ENV-VARS-START -->";
const ENV_END_MARKER = "<!-- AUTO-GENERATED:ENV-VARS-END -->";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const README_PATH = join(PROJECT_ROOT, "README.md");
const MCP_MANIFEST_PATH = join(PROJECT_ROOT, "mcp.json");

type ManifestEnvEntry = {
  readonly description: string;
  readonly default?: string;
};

type EnvCategory =
  | "Server Runtime"
  | "C64 Ultimate"
  | "VICE Runtime"
  | "VICE Audio Capture"
  | "SID Playback"
  | "RAG"
  | "Testing";

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n|\r/g, " ").trim();
}

export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const headerLine = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return [headerLine, separator, body].filter(Boolean).join("\n");
}

function loadManifestEnv(): Readonly<Record<string, ManifestEnvEntry>> {
  const manifest = JSON.parse(readFileSync(MCP_MANIFEST_PATH, "utf8")) as {
    env?: Record<string, ManifestEnvEntry>;
  };
  return manifest.env ?? {};
}

function classifyEnvVariable(name: string): EnvCategory {
  if (name.startsWith("C64U_")) {
    return "C64 Ultimate";
  }
  if (name.startsWith("VICE_") || name === "FORCE_XVFB" || name === "DISABLE_XVFB") {
    if (name === "VICE_MODE" || name === "VICE_LIMIT_CYCLES" || name === "VICE_RUN_TIMEOUT_MS") {
      return "VICE Audio Capture";
    }
    return "VICE Runtime";
  }
  if (name.startsWith("SIDPLAY")) {
    return "SID Playback";
  }
  if (name.startsWith("RAG_") || name === "GITHUB_TOKEN") {
    return "RAG";
  }
  if (name === "C64_TEST_TARGET") {
    return "Testing";
  }
  return "Server Runtime";
}

function resolveJsonConfigKey(name: string): string {
  const map: Record<string, string> = {
    C64BRIDGE_CONFIG: "config path",
    C64U_HOST: "c64u.host",
    C64U_PORT: "c64u.port",
    C64U_PASSWORD: "c64u.networkPassword",
    VICE_BINARY: "vice.exe",
    VICE_DIRECTORY: "vice.directory",
    VICE_HOST: "vice.host",
    VICE_PORT: "vice.port",
    VICE_VISIBLE: "vice.visible",
    VICE_WARP: "vice.warp",
    VICE_ARGS: "vice.args",
  };
  return map[name] ?? "—";
}

export function renderEnvironmentSection(envEntries: Readonly<Record<string, ManifestEnvEntry>> = loadManifestEnv()): string[] {
  const grouped = new Map<EnvCategory, Array<[string, ManifestEnvEntry]>>();

  for (const entry of Object.entries(envEntries).sort(([left], [right]) => left.localeCompare(right))) {
    const category = classifyEnvVariable(entry[0]);
    const rows = grouped.get(category) ?? [];
    rows.push(entry);
    grouped.set(category, rows);
  }

  const orderedCategories: readonly EnvCategory[] = [
    "Server Runtime",
    "C64 Ultimate",
    "VICE Runtime",
    "VICE Audio Capture",
    "SID Playback",
    "RAG",
    "Testing",
  ];

  const lines: string[] = [
    "Every runtime environment variable documented in `mcp.json` can be set in your MCP client configuration, including `.vscode/mcp.json` under `servers.c64bridge.env`.",
    "",
  ];

  for (const category of orderedCategories) {
    const entries = grouped.get(category);
    if (!entries || entries.length === 0) {
      continue;
    }

    lines.push(`#### ${category}`);
    lines.push("");
    lines.push(renderTable(
      ["Variable", "Default", "JSON Config Key", "Description"],
      entries.map(([name, spec]) => [
        `\`${name}\``,
        escapeCell(spec.default ?? "—"),
        escapeCell(resolveJsonConfigKey(name)),
        escapeCell(spec.description),
      ]),
    ));
    lines.push("");
  }

  return lines;
}

type GroupedOperation = {
  readonly op: string;
  readonly description: string;
  readonly required: readonly string[];
  readonly notes: readonly string[];
};

type GroupedToolInfo = {
  readonly tool: ToolDescriptor;
  readonly operations: readonly GroupedOperation[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function toTableValue(values: readonly string[]): string {
  if (!values.length) {
    return "—";
  }
  return values.join(", ");
}

function collectGroupedOperations(schema?: JsonSchema): readonly GroupedOperation[] {
  if (!schema || !isObject(schema)) {
    return [];
  }

  const metadataOperations = collectFromOperationMetadata(schema);
  if (metadataOperations.length > 0) {
    return metadataOperations;
  }

  const discriminator = (schema as JsonSchema & { discriminator?: { propertyName?: string } }).discriminator;
  const variants = (schema as JsonSchema & { oneOf?: readonly JsonSchema[] }).oneOf;

  if (discriminator && discriminator.propertyName === "op" && Array.isArray(variants)) {
    return collectFromVariantList(variants);
  }

  return collectFromFlattenedSchema(schema);
}

function collectFromOperationMetadata(schema: JsonSchema): readonly GroupedOperation[] {
  const metadata = (schema as JsonSchema & {
    readonly "x-c64bridge-operations"?: readonly unknown[];
  })["x-c64bridge-operations"];

  if (!Array.isArray(metadata)) {
    return [];
  }

  const operations: GroupedOperation[] = [];

  for (const entry of metadata) {
    if (!isObject(entry)) {
      continue;
    }

    const opName = getString(entry.op);
    if (!opName) {
      continue;
    }

    const inputSchema = isObject(entry.inputSchema) ? (entry.inputSchema as JsonSchema) : undefined;
    const properties = (inputSchema?.properties ?? {}) as Record<string, JsonSchema | undefined>;
    const requiredProps = Array.isArray(entry.required)
      ? entry.required.filter((name): name is string => typeof name === "string" && name !== "op")
      : [];

    const notes: string[] = [];
    const hasVerificationProperty = Object.keys(properties).some((name) =>
      name.toLowerCase().startsWith("verify"),
    );
    if (hasVerificationProperty) {
      notes.push("supports verify");
    }

    operations.push({
      op: opName,
      description: getString(entry.description, `Operation ${opName}`),
      required: requiredProps,
      notes,
    });
  }

  return operations;
}

function collectFromVariantList(variants: readonly JsonSchema[]): readonly GroupedOperation[] {
  const operations: GroupedOperation[] = [];

  for (const variant of variants) {
    if (!variant || !isObject(variant)) {
      continue;
    }

    const typedVariant = variant as JsonSchema;
    const properties = (typedVariant.properties ?? {}) as Record<string, JsonSchema | undefined>;
    const opSchema = properties.op;

    let opName: string | undefined;
    if (opSchema && isObject(opSchema)) {
      const constValue = (opSchema as JsonSchema & { const?: unknown }).const;
      if (typeof constValue === "string" && constValue.length > 0) {
        opName = constValue;
      } else if (Array.isArray((opSchema as JsonSchema).enum) && (opSchema as JsonSchema).enum![0]) {
        const enumValue = (opSchema as JsonSchema).enum![0];
        if (typeof enumValue === "string") {
          opName = enumValue;
        }
      }
    }

    if (!opName) {
      continue;
    }

    const description = getString(typedVariant.description, getString(opSchema?.description, `Operation ${opName}`));
    const requiredProps = ((typedVariant.required as readonly string[] | undefined) ?? []).filter((name) => name !== "op");

    const notes: string[] = [];
    const hasVerificationProperty = Object.keys(properties).some((name) =>
      name.toLowerCase().startsWith("verify"),
    );
    if (hasVerificationProperty) {
      notes.push("supports verify");
    }

    operations.push({
      op: opName,
      description,
      required: requiredProps,
      notes,
    });
  }

  return operations;
}

function collectFromFlattenedSchema(schema: JsonSchema): readonly GroupedOperation[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema | undefined>;
  const opSchema = properties.op;
  if (!opSchema || !isObject(opSchema)) {
    return [];
  }

  const enumValues = (opSchema as JsonSchema).enum;
  if (!Array.isArray(enumValues) || enumValues.length === 0) {
    return [];
  }

  const opNames = enumValues.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (opNames.length === 0) {
    return [];
  }

  const descriptionMap = parseOperationDescriptions(getString(schema.description));
  const hasVerificationProperty = Object.keys(properties).some((name) =>
    name !== "op" && name.toLowerCase().startsWith("verify"),
  );
  const notes = hasVerificationProperty ? ["supports verify"] : [];

  return opNames.map((opName) => ({
    op: opName,
    description: descriptionMap.get(opName) ?? `Operation ${opName}`,
    required: [] as readonly string[],
    notes,
  }));
}

function parseOperationDescriptions(description: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!description) {
    return result;
  }

  const lines = description.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*-\s+([A-Za-z0-9_]+):\s*(.+)$/);
    if (match) {
      result.set(match[1], match[2].trim());
    }
  }

  return result;
}

export function renderToolsSection(modules: readonly ToolModuleDescriptor[] = describeToolModules()): string[] {
  const lines: string[] = ["### Tools", ""];
  const groupedTools: GroupedToolInfo[] = [];

  for (const module of modules) {
    for (const tool of module.tools) {
      const operations = collectGroupedOperations(tool.inputSchema);
      groupedTools.push({ tool, operations });
    }
  }

  groupedTools
    .slice()
    .sort((a, b) => a.tool.name.localeCompare(b.tool.name))
    .forEach(({ tool, operations }) => {
      lines.push(`#### ${tool.name}`);
      lines.push("");
      lines.push(tool.description.trim() || "No description provided.");
      lines.push("");

      if (operations.length === 0) {
        lines.push("_No operations defined._");
      } else {
        const toolPlatforms: readonly string[] = tool.metadata.platforms ?? ["c64u"];
        const opPlatformOverrides: Record<string, readonly string[]> = tool.metadata.operationPlatforms ?? {};
        const operationRows = operations
          .slice()
          .sort((a, b) => a.op.localeCompare(b.op))
          .map((operation) => {
            const effectivePlatforms = opPlatformOverrides[operation.op] ?? toolPlatforms;
            return [
              `\`${operation.op}\``,
              escapeCell(operation.description),
              escapeCell(toTableValue(operation.required.map((name) => `\`${name}\``))),
              operation.notes.length ? escapeCell(operation.notes.join(", ")) : "—",
              effectivePlatforms.includes("c64u") ? "✅" : "",
              effectivePlatforms.includes("vice") ? "✅" : "",
            ];
          });

        lines.push(renderTable(["Operation", "Description", "Required Inputs", "Notes", "C64U", "VICE"], operationRows));
      }

      lines.push("");
    });

  return lines;
}

export function renderResourcesSection(): string[] {
  const resources = listKnowledgeResources()
    .slice()
    .sort((a, b) => {
      const bundleOrder = a.metadata.bundle.order - b.metadata.bundle.order;
      if (bundleOrder !== 0) {
        return bundleOrder;
      }
      return a.metadata.order - b.metadata.order;
    });

  const rows = resources.map((resource) => [
    `\`${resource.uri}\``,
    escapeCell(resource.metadata.summary || resource.description),
  ]);

  return [
    "### Resources",
    "",
    rows.length ? renderTable(["Name", "Summary"], rows) : "_No resources registered._",
    "",
  ];
}

export function renderPromptsSection(): string[] {
  const promptRegistry = createPromptRegistry();
  const prompts = promptRegistry
    .list()
    .slice()
    .sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));

  const rows = prompts.map((entry) => [
    `\`${entry.descriptor.name}\``,
    escapeCell(entry.descriptor.description),
  ]);

  return [
    "### Prompts",
    "",
    rows.length ? renderTable(["Name", "Description"], rows) : "_No prompts registered._",
    "",
  ];
}

export function renderSummarySection(): string[] {
  const modules = describeToolModules();
  const resources = listKnowledgeResources();
  const promptRegistry = createPromptRegistry();
  const prompts = promptRegistry.list();

  const toolCount = modules.reduce((sum, module) => sum + module.tools.length, 0);
  const resourceCount = resources.length;
  const promptCount = prompts.length;

  return [
    `This MCP server exposes **${toolCount} tools**, **${resourceCount} resources**, and **${promptCount} prompts** for controlling your Commodore 64.`,
    "",
  ];
}

export function buildDocumentation(): string {
  const sections = [renderSummarySection(), renderToolsSection(), renderResourcesSection(), renderPromptsSection()];
  return sections.flat().join("\n").trim();
}

export function buildEnvironmentDocumentation(): string {
  return renderEnvironmentSection().join("\n").trim();
}

export async function updateReadme(): Promise<boolean> {
  const readme = await readFile(README_PATH, "utf8");
  const docsPattern = new RegExp(
    `${START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s\\S]*?)${END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  const envPattern = new RegExp(
    `${ENV_START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s\\S]*?)${ENV_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  if (!docsPattern.test(readme)) {
    throw new Error(
      `Could not find auto-generated section markers (${START_MARKER} / ${END_MARKER}) in README.md`,
    );
  }
  if (!envPattern.test(readme)) {
    throw new Error(
      `Could not find auto-generated section markers (${ENV_START_MARKER} / ${ENV_END_MARKER}) in README.md`,
    );
  }

  const generatedDocs = `\n\n${buildDocumentation()}\n\n`;
  const generatedEnv = `\n\n${buildEnvironmentDocumentation()}\n\n`;
  const nextReadme = readme
    .replace(docsPattern, `${START_MARKER}${generatedDocs}${END_MARKER}`)
    .replace(envPattern, `${ENV_START_MARKER}${generatedEnv}${ENV_END_MARKER}`);

  if (nextReadme === readme) {
    return false;
  }

  await writeFile(README_PATH, nextReadme, "utf8");
  return true;
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    const entryUrl = pathToFileURL(resolvePath(entry)).href;
    return entryUrl === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const updated = await updateReadme();
    if (updated) {
      console.error("README.md updated with MCP documentation.");
    }
  } catch (error) {
    console.error("Failed to update README.md:", error);
    process.exitCode = 1;
  }
}
