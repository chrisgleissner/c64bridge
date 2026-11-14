import { redactValue } from "../redact.js";
import type { ToolRunResult } from "../tools/types.js";

// ToolRunResult.metadata is not an MCP result field, and textResult already copies
// it into structuredContent.data. Keys whose value is already present in
// structuredContent.data are not sent again; forwarding the whole object sent every
// payload (for example the hex of a memory read) an extra time. Keys that
// structuredContent does not carry (small flags and counts from jsonResult) are kept.
function metadataNotInStructuredContent(
  metadata: Record<string, unknown>,
  structured: ToolRunResult["structuredContent"],
): Record<string, unknown> {
  const data = structured?.data;
  const record = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const remaining: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key in record && JSON.stringify(record[key]) === JSON.stringify(value)) continue;
    remaining[key] = value;
  }
  return remaining;
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
    const remaining = metadataNotInStructuredContent(result.metadata, result.structuredContent);
    if (Object.keys(remaining).length > 0) {
      base.metadata = redactValue(remaining) as ToolRunResult["metadata"];
    }
  }
  if (result.isError !== undefined) {
    base.isError = result.isError;
  }

  return base;
}
