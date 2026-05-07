import { afterEach, describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import {
  buildEnvironmentDocumentation,
  buildDocumentation,
  renderEnvironmentSection,
  renderTable,
  renderPromptsSection,
  renderResourcesSection,
  renderSummarySection,
  renderToolsSection,
  updateReadme,
} from "../scripts/update-readme.ts";

const readmePath = new URL("../README.md", import.meta.url);
let readmeBackup;

afterEach(async () => {
  if (typeof readmeBackup === "string") {
    await writeFile(readmePath, readmeBackup, "utf8");
    readmeBackup = undefined;
  }
});

function renderToolsAsString() {
  return renderToolsSection().join("\n");
}

describe("update-readme grouped operations", () => {
  it("includes an operations table for grouped tools", () => {
    const output = renderToolsAsString();
    expect(output).toContain("#### c64_program");
    expect(output).toContain("| `run_prg`");
    expect(output).toContain("| `upload_run_basic`");
    expect(output).toContain("#### c64_memory");
    expect(output).toContain("| `wait_for_text`");
    expect(output).not.toContain("#####");
  });

  it("renders summary, resources, and prompts sections", () => {
    const summary = renderSummarySection().join("\n");
    const environment = renderEnvironmentSection().join("\n");
    const resources = renderResourcesSection().join("\n");
    const prompts = renderPromptsSection().join("\n");

    expect(summary).toContain("This MCP server exposes");
    expect(environment).toContain("#### C64 Ultimate");
    expect(environment).toContain("C64U_HOST");
    expect(resources).toContain("### Resources");
    expect(resources).toContain("c64://basic/spec");
    expect(prompts).toContain("### Prompts");
    expect(prompts).toContain("basic-program");
  });

  it("builds complete MCP documentation with all major sections", () => {
    const output = buildDocumentation();
    const environment = buildEnvironmentDocumentation();
    expect(output).toContain("### Tools");
    expect(output).toContain("#### c64_program");
    expect(output).toContain("### Resources");
    expect(output).toContain("### Prompts");
    expect(output).toContain("| Operation | Description | Required Inputs | Notes | C64U | VICE |");
    expect(environment).toContain("| Variable | Default | JSON Config Key | Description |");
    expect(environment).toContain("VICE_DIRECTORY");
  });

  it("renders custom grouped tools with platform overrides, verify notes, and empty tools", () => {
    const output = renderToolsSection([
      {
        tools: [
          {
            name: "c64_custom",
            description: "Custom grouped tool.",
            inputSchema: {
              discriminator: { propertyName: "op" },
              oneOf: [
                {
                  description: "Uploads and verifies memory.",
                  type: "object",
                  properties: {
                    op: { const: "upload" },
                    payload: { type: "string", description: "Payload" },
                    verifyWrite: { type: "boolean", description: "Verify write" },
                  },
                  required: ["op", "payload"],
                },
                {
                  type: "object",
                  properties: {
                    op: { enum: ["probe"] },
                  },
                  required: ["op"],
                },
                null,
              ],
            },
            metadata: {
              platforms: ["c64u"],
              operationPlatforms: { probe: ["vice"] },
            },
          },
          {
            name: "c64_empty",
            description: "Ungrouped placeholder.",
            inputSchema: { type: "object", properties: {} },
            metadata: { platforms: ["c64u"] },
          },
        ],
      },
    ]).join("\n");

    expect(output).toContain("#### c64_custom");
    expect(output).toContain("| `upload` | Uploads and verifies memory. | `payload` | supports verify | ✅ |  |");
    expect(output).toContain("| `probe` | Operation probe | — | — |  | ✅ |");
    expect(output).toContain("#### c64_empty");
    expect(output).toContain("_No operations defined._");
  });

  it("renders flattened grouped schemas produced for Claude-compatible tools", () => {
    const output = renderToolsSection([
      {
        tools: [
          {
            name: "c64_flattened",
            description: "Flattened grouped tool.",
            inputSchema: {
              type: "object",
              description: [
                "Flattened operations for Claude.",
                "",
                "Operations:",
                "- upload: Upload bytes into memory.",
                "- probe: Probe emulator state.",
              ].join("\n"),
              properties: {
                op: { type: "string", enum: ["upload", "probe"] },
                payload: { type: "string", description: "Payload" },
                verifyWrite: { type: "boolean", description: "Verify write" },
              },
              required: ["op"],
              additionalProperties: false,
            },
            metadata: {
              platforms: ["c64u", "vice"],
              operationPlatforms: { upload: ["c64u"] },
            },
          },
        ],
      },
    ]).join("\n");

    expect(output).toContain("#### c64_flattened");
    expect(output).toContain("| `upload` | Upload bytes into memory. | — | supports verify | ✅ |  |");
    expect(output).toContain("| `probe` | Probe emulator state. | — | supports verify | ✅ | ✅ |");
  });

  it("renders required inputs from flattened grouped schema metadata", () => {
    const output = renderToolsSection([
      {
        tools: [
          {
            name: "c64_flattened_metadata",
            description: "Flattened grouped tool with operation metadata.",
            inputSchema: {
              type: "object",
              description: "Flattened operations.",
              properties: {
                op: { type: "string", enum: ["upload", "probe"] },
                payload: { type: "string", description: "Payload" },
                verifyWrite: { type: "boolean", description: "Verify write" },
              },
              required: ["op"],
              additionalProperties: false,
              "x-c64bridge-operations": [
                {
                  op: "upload",
                  description: "Upload bytes into memory.",
                  required: ["payload"],
                  inputSchema: {
                    type: "object",
                    properties: {
                      op: { const: "upload" },
                      payload: { type: "string", description: "Payload" },
                      verifyWrite: { type: "boolean", description: "Verify write" },
                    },
                    required: ["op", "payload"],
                    additionalProperties: false,
                  },
                },
                {
                  op: "probe",
                  description: "Probe emulator state.",
                  required: [],
                  inputSchema: {
                    type: "object",
                    properties: {
                      op: { const: "probe" },
                    },
                    required: ["op"],
                    additionalProperties: false,
                  },
                },
              ],
            },
            metadata: {
              platforms: ["c64u", "vice"],
            },
          },
        ],
      },
    ]).join("\n");

    expect(output).toContain("| `upload` | Upload bytes into memory. | `payload` | supports verify | ✅ | ✅ |");
    expect(output).toContain("| `probe` | Probe emulator state. | — | — | ✅ | ✅ |");
  });

  it("escapes tables and updates the generated README section", async () => {
    expect(renderTable(["A", "B"], [["left|side", "line1\nline2"]])).toContain("left|side");

    readmeBackup = await readFile(readmePath, "utf8");
    const minimalReadme = [
      "# Test README",
      "",
      "<!-- AUTO-GENERATED:ENV-VARS-START -->",
      "stale env",
      "<!-- AUTO-GENERATED:ENV-VARS-END -->",
      "",
      "<!-- AUTO-GENERATED:MCP-DOCS-START -->",
      "stale",
      "<!-- AUTO-GENERATED:MCP-DOCS-END -->",
      "",
    ].join("\n");
    await writeFile(readmePath, minimalReadme, "utf8");

    const updated = await updateReadme();
    const nextReadme = await readFile(readmePath, "utf8");
    const unchanged = await updateReadme();

    expect(updated).toBe(true);
    expect(nextReadme).toContain("### Tools");
    expect(nextReadme).toContain("#### C64 Ultimate");
    expect(nextReadme).not.toContain("stale");
    expect(nextReadme).not.toContain("stale env");
    expect(unchanged).toBe(false);
  });

  it("throws when the README markers are missing", async () => {
    readmeBackup = await readFile(readmePath, "utf8");
    await writeFile(readmePath, "# Missing markers\n", "utf8");
    await expect(updateReadme()).rejects.toThrow("Could not find auto-generated section markers");
  });
});
