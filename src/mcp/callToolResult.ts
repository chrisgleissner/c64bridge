import { redactResultText, redactResultValue, redactValue } from "../redact.js";
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

/**
 * Successful results are redacted per string leaf, whole-word for short secrets. The text of a JSON
 * block is parsed and regenerated from the redacted value, and is kept byte for byte when nothing
 * changed. Image blocks are never altered. Error results use substring redaction of everything
 * except image data.
 */
function redactContent(content: ToolRunResult["content"], isError: boolean): ToolRunResult["content"] {
  return content.map((block) => {
    if (block.type !== "text") return block;
    if (isError) return { ...block, text: redactValue(block.text) as string };
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.text);
    } catch {
      return { ...block, text: redactResultText(block.text) };
    }
    if (parsed === null || typeof parsed !== "object") {
      return { ...block, text: redactResultText(block.text) };
    }
    const redacted = redactResultValue(parsed);
    return JSON.stringify(redacted) === JSON.stringify(parsed) ? block : { ...block, text: JSON.stringify(redacted) };
  });
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
  } = { content: redactContent(result.content, result.isError === true) };

  if (result.structuredContent !== undefined) {
    base.structuredContent = (result.isError === true
      ? redactValue(result.structuredContent)
      : redactResultValue(result.structuredContent)) as ToolRunResult["structuredContent"];
  }
  if (result.metadata !== undefined) {
    const remaining = metadataNotInStructuredContent(result.metadata, result.structuredContent);
    if (Object.keys(remaining).length > 0) {
      base.metadata = (result.isError === true ? redactValue(remaining) : redactResultValue(remaining)) as ToolRunResult["metadata"];
    }
  }
  if (result.isError !== undefined) {
    base.isError = result.isError;
  }

  return base;
}
